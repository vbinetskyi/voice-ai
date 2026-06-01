// ─── API LAYER ───────────────────────────────────────────────────────────────
// Hono middleware that injects service dependencies into the request context.
//
// Hono's generic <AppEnv> makes injected values type-safe: route handlers
// access deps via c.var.callService and TypeScript knows the exact type.
// All deps are set once here rather than imported directly in each router,
// which keeps routing modules decoupled from the composition root (index.ts).
// ─────────────────────────────────────────────────────────────────────────────

import { createMiddleware } from "hono/factory";
import type { CallService } from "../service/CallService";

// Defines the shape of Hono's context variables for this app.
// Add new service-layer deps here first, then set them in buildServiceMiddleware.
export type AppEnv = {
	Variables: {
		callService: CallService;
	};
};

export function buildServiceMiddleware(deps: AppEnv["Variables"]) {
	return createMiddleware<AppEnv>(async (c, next) => {
		c.set("callService", deps.callService);
		await next();
	});
}
