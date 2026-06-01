// ─── SERVICE LAYER ───────────────────────────────────────────────────────────
// CallBridge is the per-call runtime object.
// It is created when Twilio opens the WebSocket stream and disposed when the
// call ends. Its job is to wire together three things:
//   1. Twilio audio in  → forward to the AI
//   2. AI audio out     → forward to the caller via MediaSink
//   3. AI function call → pause the call, expose question via SessionRepository
// ─────────────────────────────────────────────────────────────────────────────

import type {
	MediaSink,
	RealtimeAIClient,
	RealtimeAISession,
	SessionRepository,
} from "../repository";

// A map from sessionId → CallBridge, shared across the whole server.
// Used to route answers back to the correct bridge and to detect reconnects.
export type CallBridgeRegistry = Map<string, CallBridge>;

// This tool is registered with the AI so it can pause the conversation and
// wait for a human decision. When the AI calls it, the session status changes
// to "awaiting_input" and the question is stored on the session.
// The call resumes when the user submits an answer via the REST API.
const REQUEST_USER_INPUT_TOOL = {
	name: "request_user_input",
	description:
		"MUST be called before answering any specific question from the business (name, preference, time, date, quantity, order details, confirmation, etc.). You have NO knowledge of these details — the client is your only source. Never guess or invent — always call this tool first, then relay the answer to the business.",
	parameters: {
		type: "object",
		properties: {
			question: {
				type: "string",
				description: "The question to present to the user",
			},
			context: {
				type: "string",
				description: "Context about why this input is needed",
			},
		},
		required: ["question", "context"],
	},
};

// Signals that the goal has been achieved and the call should end.
const HANG_UP_TOOL = {
	name: "hang_up",
	description:
		"Terminate the phone call. MUST be called to end the call — saying goodbye is not enough. The call continues indefinitely until this tool is invoked.",
	parameters: {
		type: "object",
		properties: {},
		required: [],
	},
};

export class CallBridge {
	private aiSession: RealtimeAISession | null = null;

	// Twilio starts sending audio as soon as the WebSocket opens, but the AI
	// session takes a moment to establish. Audio that arrives before the AI is
	// ready is buffered here and drained once the connection is up.
	private pendingAudio: string[] = [];

	// Twilio fires both the "stop" stream event AND the WebSocket onClose event
	// when a call ends, which would cause dispose() to run twice. This flag
	// makes the second call a no-op.
	private isDisposed = false;

	constructor(
		private readonly sessionId: string,
		private readonly goal: string, // the instruction the AI should pursue on the call
		private readonly realtimeClient: RealtimeAIClient,
		private readonly sessionRepo: SessionRepository,
		private readonly registry: CallBridgeRegistry,
		private readonly mediaSink: MediaSink, // sends AI audio back to the caller
		private readonly onHangUp: () => Promise<void>, // terminates the telephony call
		private readonly audioFormat: "mulaw8k" | "pcm16_24k" = "mulaw8k",
	) {}

	// Opens the AI session and wires up all event handlers.
	// Must be called once after construction. Throws if the AI connection fails.
	async attach(): Promise<void> {
		const aiSession = await this.realtimeClient.open({
			audioFormat: this.audioFormat,
			greetingInstructions: `SYSTEM: Speak exactly one sentence as your greeting. Begin with "Hi, I'm an AI assistant calling on behalf of a client —" then complete it by expressing the goal as a natural first-person intention. Goal: "${this.goal}". Example: goal "order pizza" → "Hi, I'm an AI assistant calling on behalf of a client — I'd like to order a pizza." Say nothing else after the sentence.`,
			instructions: `You are an AI assistant on a phone call. You called a business on behalf of your employer.

Goal: ${this.goal}

TWO CHANNELS — understand this clearly:
- VOICE (the phone): the business employee hears everything you say. Use voice only to speak TO the business.
- request_user_input (silent tool): sends a text message to your employer who is NOT on the call. Your employer replies through this tool only.

YOUR ROLE: You are the customer. You placed this call. You wait to be served.

STRICT RULES:
1. After your opening greeting, STOP and wait silently. Do not speak again until the business addresses you. Do not call any tool during or right after the greeting.
2. NEVER ask the business any question. You are the customer — they serve you, not the other way around.
3. When the business addresses you in ANY way — asks a question, lists options, states a price, asks for confirmation, or anything else that requires a response — say ONLY a 2-3 word acknowledgment (e.g. "let me check" / "just a second" / "sure, hold on" / "I'll check" — do NOT say "one moment"). Say NOTHING else. Then call request_user_input. Do NOT add any explanation, do NOT repeat the business's question out loud, do NOT address your employer through speech. Your employer is deaf to your voice — request_user_input is the ONLY channel to them.
4. After receiving the answer from request_user_input, relay it to the business in one sentence. Then STOP — no follow-up questions, no comments.
5. The goal tells you WHAT to accomplish, not WHAT to say. It gives you NO permission to invent specific details.
6. ZERO exceptions: even if the goal mentions a specific item (pizza type, name, time, quantity, etc.), you MUST confirm it via request_user_input before telling the business. Never guess, invent, or assume any detail.

BAD: business asks "what kind of pizza?" → you answer "pepperoni" (invented) — WRONG.
BAD: you ask "what pizzas do you have?" — WRONG, you never ask the business questions.
BAD: say "Let me check. The business is asking which pizza you want." — WRONG, the extra sentence is employer-directed speech your employer cannot hear.
GOOD: business asks "what kind of pizza?" → say "let me check" → immediately call request_user_input("The business is asking what kind of pizza you want.") → get answer → relay it in one sentence → stop.

Write request_user_input questions in English.
When the goal is fully complete and confirmed, say goodbye and call hang_up.`,
			tools: [REQUEST_USER_INPUT_TOOL, HANG_UP_TOOL],
		});

		// Guard: dispose() may have been called while open() was awaiting.
		// aiSession is live but untracked — close it and bail out.
		if (this.isDisposed) {
			aiSession.close();
			return;
		}
		this.aiSession = aiSession;

		// AI produced speech — send it to the caller.
		this.aiSession.onAudio((base64) => {
			if (this.isDisposed) return;
			this.mediaSink.send(base64);
		});

		// AI called a tool — route to the appropriate handler.
		this.aiSession.onFunctionCall((event) => {
			if (event.name === "hang_up") {
				this.aiSession?.sendFunctionResult(
					event.callId,
					JSON.stringify({ success: true }),
				);
				// Dispose tears down the WebSocket stream (which should end the call),
				// then we explicitly hang up via the telephony API as a fallback.
				this.dispose();
				this.onHangUp().catch((err) => {
					console.error(`[bridge:${this.sessionId}] hangUpCall failed:`, err);
				});
				return;
			}

			if (event.name !== "request_user_input") {
				// Unrecognised tool: send an error result so Grok isn't left waiting.
				this.aiSession?.sendFunctionResult(
					event.callId,
					JSON.stringify({ error: "unknown_tool" }),
				);
				return;
			}
			let args: { question: string; context: string };
			try {
				args = JSON.parse(event.arguments) as {
					question: string;
					context: string;
				};
				if (!args.question?.trim() || !args.context?.trim()) {
					throw new Error("missing fields");
				}
			} catch {
				// Malformed or incomplete arguments: send an error so Grok isn't left waiting.
				this.aiSession?.sendFunctionResult(
					event.callId,
					JSON.stringify({ error: "invalid_arguments" }),
				);
				return;
			}
			this.sessionRepo.update(this.sessionId, (session) => {
				session.status = "awaiting_input";
				session.pendingQuestion = {
					functionCallId: event.callId, // saved so we can resume the AI later
					question: args.question,
					context: args.context,
				};
			});
		});

		// AI session closed (network error, provider timeout, etc.) — clean up.
		this.aiSession.onClose(() => {
			this.dispose();
		});

		// Drain audio that arrived while the AI connection was being established.
		for (const audio of this.pendingAudio) {
			this.aiSession.sendAudio(audio);
		}
		this.pendingAudio = [];
	}

	// Called for every "media" event from the Twilio WebSocket.
	// If the AI session is not ready yet, the audio is buffered.
	forwardAudioToGrok(base64: string): void {
		if (this.isDisposed) return;
		if (!this.aiSession) {
			this.pendingAudio.push(base64);
			return;
		}
		this.aiSession.sendAudio(base64);
	}

	// Called by CallService.submitAnswer() after the user responds to a question.
	// Sends the answer to the AI as a function call result, which resumes
	// the AI's response generation.
	submitFunctionResult(callId: string, answer: string): void {
		if (this.isDisposed) return;
		this.aiSession?.sendFunctionResult(callId, JSON.stringify({ answer }));
	}

	// Tears down the bridge: closes AI session, closes the Twilio WebSocket,
	// removes itself from the registry, and marks the session as ended.
	dispose(): void {
		if (this.isDisposed) return;
		this.isDisposed = true;
		this.aiSession?.close();
		this.mediaSink.close();
		this.registry.delete(this.sessionId); // prevent memory leak
		this.sessionRepo.update(this.sessionId, (session) => {
			session.status = "ended";
			session.pendingQuestion = null;
		});
	}
}
