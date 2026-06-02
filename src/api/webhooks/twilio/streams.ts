// ─── API LAYER ───────────────────────────────────────────────────────────────
// Twilio Media Stream WebSocket handler.
//
// After our TwiML webhook responds with <Connect><Stream>, Twilio opens a
// WebSocket here and starts sending JSON frames containing raw audio.
//
// Twilio stream event types:
//   "connected" — WebSocket just opened (no audio yet)
//   "start"     — stream is live, includes streamSid needed to send audio back
//   "media"     — audio chunk from the caller (base64 G.711 μ-law)
//   "stop"      — caller hung up or call ended
//
// To send audio back to the caller, we write JSON frames in the same format:
//   { event: "media", streamSid: "...", media: { payload: "<base64>" } }
//
// TwilioMediaSink implements the MediaSink port so that CallBridge can send
// audio without knowing anything about Twilio or WebSockets.
// ─────────────────────────────────────────────────────────────────────────────

import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import type { WSContext } from "hono/ws";
import type { MediaSink } from "../../../repository";
import type { AppEnv } from "../../middleware";
import { logger } from "../../../logger";

// Twilio stream event shapes (incoming from Twilio)
interface TwilioStartEvent {
	event: "start";
	streamSid: string; // unique ID for this stream, needed to send audio back
}

interface TwilioMediaEvent {
	event: "media";
	media: { payload: string }; // base64-encoded G.711 μ-law audio chunk
}

interface TwilioStopEvent {
	event: "stop";
}

type TwilioStreamEvent = TwilioStartEvent | TwilioMediaEvent | TwilioStopEvent;

// Wraps a Hono WebSocket context to implement the MediaSink port.
// Formats outgoing audio as Twilio Media Stream JSON frames.
// Audio that arrives before the "start" event (and thus before streamSid is
// known) is buffered and flushed automatically once setStreamSid() is called.
// This ensures the AI's opening greeting is not silently discarded.
class TwilioMediaSink implements MediaSink {
	readonly audioFormat = "mulaw8k" as const;
	private streamSid: string | null = null;
	private buffer: string[] = [];

	constructor(private readonly ws: WSContext) {}

	setStreamSid(sid: string): void {
		this.streamSid = sid;
		for (const audio of this.buffer) {
			this.transmit(audio);
		}
		this.buffer = [];
	}

	send(base64: string): void {
		if (!this.streamSid) {
			this.buffer.push(base64);
			return;
		}
		this.transmit(base64);
	}

	private transmit(base64: string): void {
		this.ws.send(
			JSON.stringify({
				event: "media",
				streamSid: this.streamSid,
				media: { payload: base64 },
			}),
		);
	}

	close(): void {
		this.buffer = [];
		this.ws.close();
	}
}

export const streamsRouter = new Hono<AppEnv>();

streamsRouter.get(
	"/streams/:sessionId",
	upgradeWebSocket((c) => {
		const sessionId = c.req.param("sessionId") as string;
		const { callService } = c.var;

		// sink is created in onOpen (when we have the WSContext) and reused
		// across all subsequent events.
		let sink: TwilioMediaSink | null = null;

		return {
			// Twilio opened the WebSocket — open the AI session and wire everything up.
			// If this throws (e.g. AI provider is down), we close with error code 1011.
			async onOpen(_evt, ws) {
				sink = new TwilioMediaSink(ws);
				try {
					await callService.openBridge(sessionId, sink);
				} catch (err) {
					logger.error("Failed to open bridge", err);
					ws.close(1011, "Upstream connection failed");
				}
			},

			onMessage(evt) {
				let msg: TwilioStreamEvent;
				try {
					msg = JSON.parse(evt.data as string) as TwilioStreamEvent;
				} catch {
					return;
				}

				if (msg.event === "start") {
					// Now we have the streamSid — required to send audio back to Twilio.
					sink?.setStreamSid(msg.streamSid);
					callService.activateSession(sessionId);
				} else if (msg.event === "media") {
					// Forward caller audio to the AI.
					callService.forwardAudio(sessionId, msg.media.payload);
				} else if (msg.event === "stop") {
					// Call ended — clean up the bridge.
					callService.closeBridge(sessionId);
				}
			},

			// Fires when the WebSocket closes for any reason (including after "stop").
			// Calling closeBridge is idempotent — the bridge's isDisposed guard
			// ensures it only runs cleanup once even if called multiple times.
			onClose() {
				callService.closeBridge(sessionId);
			},
		};
	}),
);
