// ─── COMPOSITION ROOT ────────────────────────────────────────────────────────
// The only place in the codebase that knows about every layer.
// Constructs all concrete implementations, wires them together, and
// hands the assembled app to Bun's HTTP server.
//
// Nothing in this file contains logic — it only wires things up.
// To swap an implementation (e.g. replace InMemorySessionRepository with
// PostgresSessionRepository), change only this file.
// ─────────────────────────────────────────────────────────────────────────────

import { Hono } from "hono";
import { websocket } from "hono/bun";
import { cors } from "hono/cors";
import twilio from "twilio";
import { type AppEnv, buildServiceMiddleware } from "./api/middleware";
import { apiRouter } from "./api/routes";
import { browserStreamsRouter } from "./api/webhooks/browser/streams";
import { streamsRouter } from "./api/webhooks/twilio/streams";
import { twilioRouter } from "./api/webhooks/twilio/voice";
import { config } from "./config";
import { GrokRealtimeAdapter } from "./infrastructure/GrokRealtimeAdapter";
import { InMemorySessionRepository } from "./infrastructure/InMemorySessionRepository";
import { TwilioCallGateway } from "./infrastructure/TwilioCallGateway";
import { CallService } from "./service/CallService";

// ── Infrastructure ────────────────────────────────────────────────────────────
const sessionRepo = new InMemorySessionRepository();
const twilioClient = twilio(
	config.TWILIO_ACCOUNT_SID,
	config.TWILIO_AUTH_TOKEN,
);
const callGateway = new TwilioCallGateway(
	twilioClient,
	config.TWILIO_FROM_NUMBER,
);
const grokClient = new GrokRealtimeAdapter(config.GROK_API_KEY);

// Live CallBridge instances, one per active call. Keyed by sessionId.
// Shared between CallService (manages lifecycle) and the WebSocket handler
// (forwards audio events). Lives here so it is never imported by either side.
const registry = new Map();

// ── Services ──────────────────────────────────────────────────────────────────
const callService = new CallService(
	sessionRepo,
	callGateway,
	config.WEBHOOK_BASE_URL,
	registry,
	grokClient,
	config.CALL_TIME_LIMIT_SECONDS,
);

// ── HTTP app ──────────────────────────────────────────────────────────────────
const app = new Hono<AppEnv>();

app.use("*", cors());
// Inject callService into every request context via Hono middleware.
app.use("*", buildServiceMiddleware({ callService }));

app.route("/", twilioRouter); // POST /twilio/voice/:sessionId
app.route("/", apiRouter); // POST /calls, GET /sessions/:id, POST /sessions/:id/answer, POST /sessions/browser
app.route("/", streamsRouter); // GET  /streams/:sessionId        (Twilio WebSocket)
app.route("/", browserStreamsRouter); // GET  /browser-stream/:sessionId (browser WebSocket)

// Export for Bun — `websocket` handles the WS upgrade; `fetch` handles HTTP.
export default {
	port: config.PORT,
	fetch: app.fetch,
	websocket,
};
