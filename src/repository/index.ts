// ─── REPOSITORY LAYER ────────────────────────────────────────────────────────
// Abstract contracts that the infrastructure layer must implement.
// The service layer depends on these interfaces, never on concrete classes.
// This is the Dependency Inversion Principle: high-level code (service) defines
// what it needs; low-level code (infrastructure) conforms to that definition.
//
// Note: "repository" here means the abstract contracts layer (Clean Architecture),
// not the DDD Repository pattern which is specifically about data persistence.
// ─────────────────────────────────────────────────────────────────────────────

import type { Session } from "../domain/entities";

// Persists and retrieves Session entities.
// The mutator pattern on update() avoids returning a new object — it modifies
// the stored session in place, which works safely with the in-memory store.
export interface SessionRepository {
	create(session: Session): void;
	get(id: string): Session | undefined;
	update(id: string, mutator: (session: Session) => void): Session | undefined;
	delete(id: string): void;
}

// Places an outbound phone call via a telephony provider (e.g. Twilio).
// webhookUrl is where the provider will POST when the call connects,
// expecting TwiML instructions in response.
export interface CallGateway {
	placeCall(input: {
		to: string;
		webhookUrl: string; // Twilio POSTs here when the call connects to fetch TwiML
		statusCallbackUrl: string; // Twilio POSTs call lifecycle events here (completed, failed, etc.)
		timeLimitSeconds?: number;
	}): Promise<{ providerCallId: string }>;
	hangUpCall(providerCallId: string): Promise<void>;
}

// Describes a tool (function) the AI can call during conversation.
// Follows the JSON Schema format that most AI providers expect.
export interface ToolSpec {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

// Emitted by the AI when it decides to call one of its tools.
// arguments is a JSON string that must be parsed to get the actual values.
export interface FunctionCallEvent {
	name: string; // tool name, e.g. "request_user_input"
	callId: string; // provider-assigned ID, needed to submit the result back
	arguments: string; // JSON string, e.g. '{"question":"...","context":"..."}'
}

// Represents an open, live session with the realtime AI model.
// Audio flows in both directions: we send caller audio, we receive AI speech.
// Function calls happen when the AI invokes one of its registered tools.
export interface RealtimeAISession {
	sendAudio(base64: string): void; // send caller's voice to the AI
	sendFunctionResult(callId: string, outputJson: string): void; // resume AI after tool call
	onAudio(handler: (base64: string) => void): void; // AI speech to play to caller
	onFunctionCall(handler: (event: FunctionCallEvent) => void): void;
	onClose(handler: () => void): void;
	close(): void;
}

// Factory for opening a realtime AI session with given instructions and tools.
// Swap this implementation to change AI providers (e.g. Grok → OpenAI).
export interface RealtimeAIClient {
	open(options: {
		instructions: string; // system prompt / behaviour description for the AI
		tools: ToolSpec[];
		// "mulaw8k"   — Twilio transport: send/receive G.711 μ-law at 8 kHz (default)
		// "pcm16_24k" — Browser transport: send/receive PCM16 LE at 24 kHz (no transcoding)
		audioFormat?: "mulaw8k" | "pcm16_24k";
		// Override the opening greeting instruction so the goal can be embedded explicitly.
		greetingInstructions?: string;
	}): Promise<RealtimeAISession>;
}

// Abstracts sending audio back to the caller over whatever transport is in use.
// The concrete implementation (TwilioMediaSink) wraps a Hono WebSocket context
// and formats the data as Twilio Media Stream JSON frames.
// Keeping this interface in the service layer means CallBridge never imports
// anything from Hono or Twilio directly.
export interface MediaSink {
	// Audio wire format this sink expects from the AI session.
	// CallService reads this to configure the RealtimeAIClient — the sink is
	// the single source of truth for the format, not the session transport.
	readonly audioFormat: "mulaw8k" | "pcm16_24k";
	send(base64: string): void;
	close(): void;
}
