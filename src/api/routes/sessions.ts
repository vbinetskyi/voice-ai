// ─── API LAYER ───────────────────────────────────────────────────────────────
// Session routes: GET /sessions/{id}, POST /sessions/{id}/answer
// ─────────────────────────────────────────────────────────────────────────────

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../middleware";

// ── Schemas ───────────────────────────────────────────────────────────────────

const SessionDto = z
	.object({
		id: z.string().openapi({ example: "uuid-here" }),
		status: z.string().openapi({ example: "active" }),
		goal: z.string().openapi({ example: "Book a table for 2 at 7pm" }),
		transport: z.enum(["twilio", "browser"]).openapi({ example: "twilio" }),
		phoneNumber: z.string().nullable().openapi({ example: "+15551234567" }),
		pendingQuestion: z
			.object({
				question: z
					.string()
					.openapi({ example: "What time would you prefer?" }),
				context: z
					.string()
					.openapi({ example: "The restaurant asked for a preferred time" }),
			})
			.nullable()
			.openapi({ example: null }),
		createdAt: z.string().openapi({ example: "2024-01-01T00:00:00.000Z" }),
	})
	.openapi("Session");

const SubmitAnswerBody = z
	.object({
		answer: z.string().min(1).openapi({ example: "7pm works great" }),
	})
	.openapi("SubmitAnswerBody");

const OkResponse = z
	.object({ ok: z.boolean().openapi({ example: true }) })
	.openapi("OkResponse");

const ErrorResponse = z.object({ error: z.string() }).openapi("ErrorResponse");

const SessionIdParam = z.object({
	id: z
		.string()
		.openapi({ param: { name: "id", in: "path" }, example: "uuid-here" }),
});

// ── Routes ────────────────────────────────────────────────────────────────────

const getSessionRoute = createRoute({
	method: "get",
	path: "/sessions/{id}",
	request: { params: SessionIdParam },
	responses: {
		200: {
			content: { "application/json": { schema: SessionDto } },
			description: "Session state",
		},
		404: {
			content: { "application/json": { schema: ErrorResponse } },
			description: "Not found",
		},
	},
});

const submitAnswerRoute = createRoute({
	method: "post",
	path: "/sessions/{id}/answer",
	request: {
		params: SessionIdParam,
		body: { content: { "application/json": { schema: SubmitAnswerBody } } },
	},
	responses: {
		200: {
			content: { "application/json": { schema: OkResponse } },
			description: "Answer submitted",
		},
		400: {
			content: { "application/json": { schema: ErrorResponse } },
			description: "Validation error",
		},
		404: {
			content: { "application/json": { schema: ErrorResponse } },
			description: "Not found",
		},
		409: {
			content: { "application/json": { schema: ErrorResponse } },
			description: "No pending question",
		},
		503: {
			content: { "application/json": { schema: ErrorResponse } },
			description: "Bridge not active",
		},
	},
});

const endCallRoute = createRoute({
	method: "post",
	path: "/sessions/{id}/end",
	request: { params: SessionIdParam },
	responses: {
		200: {
			content: { "application/json": { schema: OkResponse } },
			description: "Call ended",
		},
		404: {
			content: { "application/json": { schema: ErrorResponse } },
			description: "Not found",
		},
	},
});

// ── Registration ──────────────────────────────────────────────────────────────

export function registerSessionRoutes(app: OpenAPIHono<AppEnv>) {
	app.openapi(getSessionRoute, (c) => {
		const { id } = c.req.valid("param");
		const session = c.var.callService.getSession(id);
		if (!session) return c.json({ error: "Not found" }, 404);
		return c.json(session, 200);
	});

	app.openapi(submitAnswerRoute, async (c) => {
		const { id } = c.req.valid("param");
		const { answer } = c.req.valid("json");
		try {
			c.var.callService.submitAnswer({ sessionId: id, answer });
			return c.json({ ok: true }, 200);
		} catch (err) {
			const code = (err as { code?: string }).code;
			if (code === "NOT_FOUND") return c.json({ error: "Not found" }, 404);
			if (code === "NO_PENDING_QUESTION")
				return c.json({ error: "No pending question" }, 409);
			if (code === "BRIDGE_UNAVAILABLE")
				return c.json({ error: "Bridge not active" }, 503);
			throw err;
		}
	});

	app.openapi(endCallRoute, async (c) => {
		const { id } = c.req.valid("param");
		try {
			await c.var.callService.terminateCall(id);
			return c.json({ ok: true }, 200);
		} catch (err) {
			const code = (err as { code?: string }).code;
			if (code === "NOT_FOUND") return c.json({ error: "Not found" }, 404);
			throw err;
		}
	});
}
