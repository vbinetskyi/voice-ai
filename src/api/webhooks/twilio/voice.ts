// ─── API LAYER ───────────────────────────────────────────────────────────────
// Twilio webhook — the first thing Twilio calls after connecting an outbound call.
//
// Flow:
//   1. Our server calls Twilio REST API to place a call (TwilioCallGateway)
//   2. Twilio dials the number; when the other party picks up, Twilio POSTs here
//   3. We respond with TwiML that tells Twilio what to do with the live call
//   4. The TwiML instructs Twilio to open a bidirectional WebSocket stream
//      to /streams/:sessionId, where raw audio will flow in both directions
// ─────────────────────────────────────────────────────────────────────────────

import { Hono } from "hono";
import twilio from "twilio";
import { config } from "../../../config";
import type { AppEnv } from "../../middleware";

const { VoiceResponse } = twilio.twiml;

export const twilioRouter = new Hono<AppEnv>();

// Validate every incoming Twilio webhook request in one place.
// WEBHOOK_BASE_URL must match the public URL Twilio calls (e.g. your ngrok host).
// Hono caches the parsed body, so handlers can call parseBody() again safely.
twilioRouter.use("/twilio/*", async (c, next) => {
	const signature = c.req.header("X-Twilio-Signature") ?? "";
	const url = `${config.WEBHOOK_BASE_URL}${c.req.path}`;
	const body = (await c.req.parseBody()) as Record<string, string>;
	if (!twilio.validateRequest(config.TWILIO_AUTH_TOKEN, signature, url, body)) {
		return c.text("Forbidden", 403);
	}
	await next();
});

twilioRouter.post("/twilio/voice/:sessionId", (c) => {
	const sessionId = c.req.param("sessionId");

	// Build TwiML using the SDK builder (not raw XML strings).
	// <Connect><Stream> opens a bidirectional WebSocket where Twilio sends
	// raw G.711 μ-law audio from the caller and we send audio back.
	const response = new VoiceResponse();
	response
		.connect()
		.stream({ url: `${config.WS_BASE_URL}/streams/${sessionId}` });

	return c.text(response.toString(), 200, { "Content-Type": "text/xml" });
});

// Terminal call statuses that mean the call is over.
const TERMINAL_STATUSES = new Set([
	"completed",
	"failed",
	"busy",
	"no-answer",
	"canceled",
]);

// Twilio POSTs here whenever the call status changes.
// We only act on terminal statuses — ensures the session is marked "ended"
// even if the media-stream WebSocket never opened (e.g. trial account hang-up,
// unanswered call, network failure before the stream was established).
twilioRouter.post("/twilio/call-status/:sessionId", async (c) => {
	const sessionId = c.req.param("sessionId");
	const body = (await c.req.parseBody()) as Record<string, string>;
	if (TERMINAL_STATUSES.has(body.CallStatus)) {
		c.var.callService.endSession(sessionId);
	}
	return c.text("", 200);
});
