// Writes the OpenAPI spec to openapi.json without starting the HTTP server.
import { apiRouter } from "../src/api/routes";

const doc = apiRouter.getOpenAPIDocument({
	openapi: "3.0.0",
	info: { version: "1.0.0", title: "Voice AI API" },
});

await Bun.write("openapi.json", JSON.stringify(doc, null, 2));
console.log("openapi.json written");
