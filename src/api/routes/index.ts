// ─── API LAYER ───────────────────────────────────────────────────────────────
// Assembles all public REST routes onto a single OpenAPIHono instance so that
// /doc produces one combined OpenAPI spec covering all resources.
// Swagger UI available at /ui, raw OpenAPI spec at /doc.
// ─────────────────────────────────────────────────────────────────────────────

import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../middleware";
import { registerBrowserRoutes } from "./browser";
import { registerCallRoutes } from "./calls";
import { registerSessionRoutes } from "./sessions";

export const apiRouter = new OpenAPIHono<AppEnv>({
	defaultHook: (result, c) => {
		if (!result.success) {
			return c.json({ error: result.error.message }, 400);
		}
	},
});

registerCallRoutes(apiRouter);
registerBrowserRoutes(apiRouter);
registerSessionRoutes(apiRouter);

// OpenAPI spec at /doc, Swagger UI at /ui
apiRouter.doc("/doc", {
	openapi: "3.0.0",
	info: { version: "1.0.0", title: "Voice AI API" },
});

apiRouter.get("/ui", (c) => {
	return c.html(`<!DOCTYPE html>
<html>
  <head>
    <title>Voice AI API</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist/swagger-ui-bundle.js"></script>
    <script>
      SwaggerUIBundle({ url: "/doc", dom_id: "#swagger-ui" })
    </script>
  </body>
</html>`);
});
