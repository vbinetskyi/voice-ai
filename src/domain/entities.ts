// ─── DOMAIN LAYER ────────────────────────────────────────────────────────────
// Pure business concepts. No framework, no infrastructure, no I/O.
// Every other layer depends on this one — it never depends on anything else.
// ─────────────────────────────────────────────────────────────────────────────

// The lifecycle of a call/session, in order:
//   dialing       → session started, waiting to become active (Twilio: awaiting pick-up; browser: awaiting WS connect)
//   active        → audio is flowing between the transport and the AI
//   awaiting_input → AI hit a question, session is paused waiting for human answer
//   ended         → session finished (hung up, errored, or user dismissed)
export type CallStatus =
	| "idle"
	| "dialing"
	| "active"
	| "awaiting_input"
	| "ended";

// When the AI needs a human decision, it calls the request_user_input tool.
// functionCallId is the AI provider's internal ID — needed to resume the AI
// after the answer is submitted. It is intentionally hidden from the HTTP layer.
export interface PendingQuestion {
	functionCallId: string;
	question: string;
	context: string;
}

// Fields shared by all session types regardless of transport.
interface BaseSession {
	id: string;
	goal: string;
	status: CallStatus;
	pendingQuestion: PendingQuestion | null;
	createdAt: Date;
}

// Outbound phone call via Twilio PSTN.
// providerCallId is null until Twilio confirms the call was placed (async).
export interface PhoneSession extends BaseSession {
	transport: "twilio";
	phoneNumber: string;
	providerCallId: string | null;
}

// Browser-based session: the user speaks through their mic directly.
// No PSTN dial — audio flows via WebSocket from the browser to the server.
export interface BrowserSession extends BaseSession {
	transport: "browser";
}

export type Session = PhoneSession | BrowserSession;
