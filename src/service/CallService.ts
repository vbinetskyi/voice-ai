// ─── SERVICE LAYER ───────────────────────────────────────────────────────────
// CallService is the application's single service class.
// It orchestrates the full call lifecycle: placing calls, managing state,
// bridging audio streams, and routing human answers back to the AI.
// It knows nothing about HTTP, WebSockets, Twilio wire formats, or Grok APIs —
// those details live in the infrastructure and API layers.
// ─────────────────────────────────────────────────────────────────────────────

import type { Session } from "../domain/entities";
import type {
	CallGateway,
	MediaSink,
	RealtimeAIClient,
	SessionRepository,
} from "../repository";
import { CallBridge, type CallBridgeRegistry } from "./CallBridge";
import { logger } from "../logger";

// The data shape returned to the HTTP layer. It deliberately omits
// functionCallId from PendingQuestion — that's an internal AI provider detail
// that HTTP clients should never see or store.
export interface SessionDto {
	id: string;
	status: string;
	goal: string;
	transport: "twilio" | "browser";
	phoneNumber: string | null; // null for browser sessions
	pendingQuestion: { question: string; context: string } | null;
	createdAt: string; // ISO 8601 string (Date serialised for JSON transport)
}

// Creates an Error with an extra `code` property so route handlers can
// distinguish domain errors from unexpected exceptions without importing
// custom error classes.
const fail = (msg: string, code: string) =>
	Object.assign(new Error(msg), { code });

export class CallService {
	constructor(
		private readonly sessionRepo: SessionRepository,
		private readonly callGateway: CallGateway,
		private readonly webhookBaseUrl: string, // e.g. https://abc.ngrok.io
		private readonly registry: CallBridgeRegistry, // live bridges, keyed by sessionId
		private readonly realtimeClient: RealtimeAIClient, // swap to change AI provider
		private readonly callTimeLimitSeconds: number,
	) {}

	// Places an outbound call and persists a new session.
	// Flow:
	//   1. Create a session in "dialing" state immediately (so the client has an ID)
	//   2. Ask the telephony gateway to place the call, passing our webhook URL
	//   3. Twilio POSTs to that URL when the call connects (see twilioRouter)
	//   4. Store the Twilio call SID on the session for reference
	async startCall(input: {
		goal: string;
		phoneNumber: string;
	}): Promise<{ sessionId: string }> {
		const id = crypto.randomUUID();
		const session: Session = {
			id,
			transport: "twilio",
			goal: input.goal,
			phoneNumber: input.phoneNumber,
			providerCallId: null, // filled in after Twilio responds
			status: "dialing",
			pendingQuestion: null,
			createdAt: new Date(),
		};
		this.sessionRepo.create(session);

		try {
			const result = await this.callGateway.placeCall({
				to: input.phoneNumber,
				webhookUrl: `${this.webhookBaseUrl}/twilio/voice/${id}`,
				statusCallbackUrl: `${this.webhookBaseUrl}/twilio/call-status/${id}`,
				timeLimitSeconds: this.callTimeLimitSeconds,
			});
			this.sessionRepo.update(id, (s) => {
				if (s.transport === "twilio") s.providerCallId = result.providerCallId;
			});
		} catch (err) {
			this.sessionRepo.delete(id);
			throw err;
		}

		return { sessionId: id };
	}

	// Returns the current state of a session for the client to poll.
	// Returns undefined if no session with that ID exists.
	getSession(id: string): SessionDto | undefined {
		const session = this.sessionRepo.get(id);
		if (!session) return undefined;
		return {
			id: session.id,
			status: session.status,
			goal: session.goal,
			transport: session.transport,
			phoneNumber: session.transport === "twilio" ? session.phoneNumber : null,
			// Strip functionCallId before handing to HTTP layer.
			pendingQuestion: session.pendingQuestion
				? {
						question: session.pendingQuestion.question,
						context: session.pendingQuestion.context,
					}
				: null,
			createdAt: session.createdAt.toISOString(),
		};
	}

	// Called when the user submits an answer to a pending question.
	// Validates that the session is actually waiting for input, then
	// resumes the AI by sending the answer as a function call result.
	submitAnswer(input: { sessionId: string; answer: string }): void {
		const session = this.sessionRepo.get(input.sessionId);
		if (!session) throw fail("Session not found", "NOT_FOUND");
		if (session.status !== "awaiting_input" || !session.pendingQuestion) {
			throw fail("No pending question", "NO_PENDING_QUESTION");
		}

		const bridge = this.registry.get(input.sessionId);
		if (!bridge) throw fail("Call bridge not active", "BRIDGE_UNAVAILABLE");

		const { functionCallId } = session.pendingQuestion;

		// Clear the pending question and resume status before sending the result,
		// so the session doesn't appear stuck if the AI responds immediately.
		this.sessionRepo.update(input.sessionId, (s) => {
			s.status = "active";
			s.pendingQuestion = null;
		});

		bridge.submitFunctionResult(functionCallId, input.answer);
	}

	// Called by the WebSocket handler when Twilio opens a media stream for a session.
	// If a bridge already exists (e.g. Twilio reconnected), the old one is disposed first.
	// mediaSink abstracts how audio gets back to Twilio — the service doesn't
	// know it's a WebSocket; it just calls sink.send(base64).
	async openBridge(sessionId: string, mediaSink: MediaSink): Promise<void> {
		// Validate BEFORE disposing any existing bridge — dispose() sets status='ended',
		// which would cause the ended-check below to always throw on reconnects.
		const session = this.sessionRepo.get(sessionId);
		if (!session) throw fail("Session not found", "NOT_FOUND");
		if (session.status === "ended")
			throw fail("Session already ended", "SESSION_ENDED");

		const existing = this.registry.get(sessionId);
		if (existing) {
			existing.dispose();
			// dispose() sets status='ended'; restore pre-dispose status for the reconnect path.
			this.sessionRepo.update(sessionId, (s) => {
				s.status = session.status;
			});
		}

		const providerCallId =
			session.transport === "twilio" ? session.providerCallId : null;
		const bridge = new CallBridge(
			sessionId,
			session.goal,
			this.realtimeClient,
			this.sessionRepo,
			this.registry,
			mediaSink,
			async () => {
				if (providerCallId) await this.callGateway.hangUpCall(providerCallId);
			},
			mediaSink.audioFormat,
		);
		// Register before attach() so forwardAudio() can reach the bridge's
		// pendingAudio buffer while the Grok WebSocket is being established.
		this.registry.set(sessionId, bridge);
		try {
			await bridge.attach();
			logger.info("bridge opened", { sessionId, transport: session.transport });
		} catch (err) {
			this.registry.delete(sessionId);
			this.sessionRepo.update(sessionId, (s) => {
				s.status = "ended";
			});
			logger.error("bridge attach failed", { sessionId, err });
			throw err;
		}
	}

	// Called when Twilio sends the "start" stream event, confirming the media
	// stream is live. Moves the session from "dialing" to "active".
	// Guards against a delayed "start" event reviving an already-ended session.
	activateSession(sessionId: string): void {
		this.sessionRepo.update(sessionId, (s) => {
			if (s.status === "dialing") s.status = "active";
		});
	}

	// Routes a raw audio chunk (base64 G.711 μ-law) from Twilio to the AI.
	// Called for every "media" WebSocket event from Twilio.
	forwardAudio(sessionId: string, base64: string): void {
		this.registry.get(sessionId)?.forwardAudioToGrok(base64);
	}

	// Tears down the bridge for a session. Called on stream "stop" or WebSocket close.
	closeBridge(sessionId: string): void {
		this.registry.get(sessionId)?.dispose();
	}

	// Called by the Twilio status callback when the call reaches a terminal state
	// (completed, failed, busy, no-answer). Disposes the bridge if still active and
	// marks the session ended — handles cases where the WebSocket never opened or
	// closed without firing the close event (e.g. trial account hang-up).
	endSession(sessionId: string): void {
		this.registry.get(sessionId)?.dispose();
		this.sessionRepo.update(sessionId, (s) => {
			if (s.status !== "ended") s.status = "ended";
		});
		logger.info("session ended", { sessionId });
	}

	// Forcibly ends a call — used by the manual "End Call" button.
	// Disposes the bridge, marks the session ended, and tells Twilio to
	// hang up via the REST API (belt-and-suspenders over WebSocket close).
	async terminateCall(sessionId: string): Promise<void> {
		const session = this.sessionRepo.get(sessionId);
		if (!session) throw fail("Session not found", "NOT_FOUND");
		this.endSession(sessionId);
		if (session.transport === "twilio" && session.providerCallId) {
			await this.callGateway.hangUpCall(session.providerCallId);
		}
	}

	// Creates a browser-based session without placing a phone call.
	// The session becomes active when the browser WebSocket connects.
	async startBrowserSession(input: {
		goal: string;
	}): Promise<{ sessionId: string }> {
		const id = crypto.randomUUID();
		this.sessionRepo.create({
			id,
			goal: input.goal,
			transport: "browser",
			status: "dialing",
			pendingQuestion: null,
			createdAt: new Date(),
		});
		logger.info("browser session created", { sessionId: id });
		return { sessionId: id };
	}
}
