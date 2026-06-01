// ─── API LAYER ───────────────────────────────────────────────────────────────
// Browser audio WebSocket handler.
//
// The browser connects here after POST /sessions/browser returns a sessionId.
// Audio protocol (both directions): raw binary frames, PCM16 LE at 24 kHz,
// mono, no header. The browser creates its AudioContext at sampleRate 24000
// so no server-side resampling is needed.
//
// Inbound  (browser → server): binary ArrayBuffer of PCM16 samples
// Outbound (server → browser): binary ArrayBuffer of PCM16 samples
// ─────────────────────────────────────────────────────────────────────────────

import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import type { WSContext } from "hono/ws";
import type { MediaSink } from "../../../repository";
import type { AppEnv } from "../../middleware";

// Implements MediaSink for the browser transport.
// GrokRealtimeAdapter with audioFormat="pcm16_24k" calls send() with
// base64-encoded PCM16 24 kHz; we decode and send as a binary WebSocket frame.
class BrowserMediaSink implements MediaSink {
	readonly audioFormat = "pcm16_24k" as const;

	constructor(private readonly ws: WSContext) {}

	send(base64: string): void {
		this.ws.send(Buffer.from(base64, "base64"));
	}

	close(): void {
		this.ws.close();
	}
}

export const browserStreamsRouter = new Hono<AppEnv>();

browserStreamsRouter.get(
	"/browser-stream/:sessionId",
	upgradeWebSocket((c) => {
		const sessionId = c.req.param("sessionId") as string;
		const { callService } = c.var;

		let sink: BrowserMediaSink | null = null;

		return {
			async onOpen(_evt, ws) {
				sink = new BrowserMediaSink(ws);
				try {
					await callService.openBridge(sessionId, sink);
					// Browser sessions have no "start" event — activate immediately.
					callService.activateSession(sessionId);
				} catch (err) {
					console.error("[browser-stream] Failed to open bridge:", err);
					ws.close(1011, "Upstream connection failed");
				}
			},

			onMessage(evt) {
				// Browser sends raw PCM16 24 kHz binary frames.
				// Bun may deliver these as Buffer, Uint8Array, or ArrayBuffer —
				// Buffer.from() handles all three without copying when possible.
				const data = evt.data;
				if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
					const base64 = Buffer.from(data as ArrayBuffer).toString("base64");
					callService.forwardAudio(sessionId, base64);
				}
			},

			onClose() {
				callService.closeBridge(sessionId);
			},
		};
	}),
);
