// ─── API LAYER ───────────────────────────────────────────────────────────────
// Call routes: POST /calls
// ─────────────────────────────────────────────────────────────────────────────

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../middleware";

// ── Schemas ───────────────────────────────────────────────────────────────────

const StartCallBody = z
	.object({
		goal: z.string().min(1).openapi({ example: "Book a table for 2 at 7pm" }),
		phoneNumber: z.string().min(1).openapi({ example: "+15551234567" }),
	})
	.openapi("StartCallBody");

const StartCallResponse = z
	.object({
		sessionId: z.string().openapi({ example: "uuid-here" }),
	})
	.openapi("StartCallResponse");

const ErrorResponse = z.object({ error: z.string() }).openapi("ErrorResponse");

// ── Route ─────────────────────────────────────────────────────────────────────

const startCallRoute = createRoute({
	method: "post",
	path: "/calls",
	request: {
		body: { content: { "application/json": { schema: StartCallBody } } },
	},
	responses: {
		201: {
			content: { "application/json": { schema: StartCallResponse } },
			description: "Call started",
		},
		400: {
			content: { "application/json": { schema: ErrorResponse } },
			description: "Validation error",
		},
	},
});

// ── Registration ──────────────────────────────────────────────────────────────

export function registerCallRoutes(app: OpenAPIHono<AppEnv>) {
	app.openapi(startCallRoute, async (c) => {
		const body = c.req.valid("json");
		const result = await c.var.callService.startCall(body);
		return c.json({ sessionId: result.sessionId }, 201);
	});
}
