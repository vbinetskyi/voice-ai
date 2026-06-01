import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
	input: "openapi.json",
	output: { path: "../voice-ai-client/src/api" },
	plugins: ["@hey-api/client-fetch"],
});
