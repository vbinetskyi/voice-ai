// ─── API LAYER ───────────────────────────────────────────────────────────────
// Browser session route: POST /sessions/browser
// Creates a session for browser-based audio (no PSTN call placed).
// ─────────────────────────────────────────────────────────────────────────────

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../middleware";

const StartBrowserSessionBody = z
	.object({
		goal: z.string().min(1).openapi({ example: "Have a casual conversation" }),
	})
	.openapi("StartBrowserSessionBody");

const StartBrowserSessionResponse = z
	.object({
		sessionId: z.string().openapi({ example: "uuid-here" }),
	})
	.openapi("StartBrowserSessionResponse");

const ErrorResponse = z.object({ error: z.string() }).openapi("ErrorResponse");

const startBrowserSessionRoute = createRoute({
	method: "post",
	path: "/sessions/browser",
	request: {
		body: {
			content: { "application/json": { schema: StartBrowserSessionBody } },
		},
	},
	responses: {
		201: {
			content: {
				"application/json": { schema: StartBrowserSessionResponse },
			},
			description: "Browser session created",
		},
		400: {
			content: { "application/json": { schema: ErrorResponse } },
			description: "Validation error",
		},
	},
});

export function registerBrowserRoutes(app: OpenAPIHono<AppEnv>) {
	app.openapi(startBrowserSessionRoute, async (c) => {
		const { goal } = c.req.valid("json");
		const result = await c.var.callService.startBrowserSession({ goal });
		return c.json({ sessionId: result.sessionId }, 201);
	});
}
