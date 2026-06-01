// Parses and validates environment variables using Zod.
// Bun automatically loads .env before the process starts, so process.env
// already contains .env values by the time this module runs — no dotenv needed.
// If any required variable is missing or invalid, Zod throws at startup with
// a clear error message rather than failing silently at runtime.

import { z } from "zod";

const schema = z.object({
	// Twilio credentials — required only for phone-call sessions.
	// Leave unset when using browser-mode only.
	TWILIO_ACCOUNT_SID: z.string().default(""),
	TWILIO_AUTH_TOKEN: z.string().default(""),
	TWILIO_FROM_NUMBER: z.string().default(""), // E.164 format, e.g. +15551234567
	GROK_API_KEY: z.string().min(1),
	WEBHOOK_BASE_URL: z.url().default("http://localhost:3000"), // HTTP — Twilio POSTs here
	WS_BASE_URL: z.url().default("ws://localhost:3000"), // WebSocket — Twilio streams here
	PORT: z.coerce.number().default(3000),
	CALL_TIME_LIMIT_SECONDS: z.coerce.number().default(300), // 5 minutes
});

export const config = schema.parse(process.env);
