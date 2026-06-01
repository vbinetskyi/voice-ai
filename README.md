# voice-ai — backend

Outbound AI phone call server. Places calls via Twilio, uses the xAI Grok Realtime API for voice, and exposes a REST API so a human operator can answer questions the AI surfaces mid-call.

## How it works

1. Client POSTs to `/calls` with a goal and phone number.
2. Server dials the number via Twilio and returns a session ID.
3. When the call connects, Twilio opens a WebSocket media stream to `/streams/:sessionId`.
4. The server bridges the audio stream to Grok Realtime — Grok speaks to the business as an AI assistant calling on behalf of the operator.
5. When Grok needs information from the operator (e.g. "what size pizza?"), it calls the `request_user_input` tool, which surfaces the question via the REST API.
6. The operator submits an answer via `POST /sessions/:id/answer`; the server resumes Grok with the answer.
7. When the goal is complete, Grok calls `hang_up` — the server closes the stream and terminates the call via the Twilio REST API.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.0
- A [Twilio](https://twilio.com) account with a voice-capable phone number
- An [xAI](https://x.ai) API key with Grok Realtime access
- A publicly reachable HTTPS/WSS URL (use [ngrok](https://ngrok.com) for local development)

> **Twilio trial accounts** can only call verified numbers. Upgrade to a paid account or verify the target number in the Twilio console first.

## Setup

```sh
# 1. Install dependencies
bun install

# 2. Copy the example env file and fill in your values
cp .env.example .env
```

Edit `.env`:

| Variable | Description |
|---|---|
| `TWILIO_ACCOUNT_SID` | Twilio account SID — starts with `AC` |
| `TWILIO_AUTH_TOKEN` | Twilio auth token |
| `TWILIO_FROM_NUMBER` | Your Twilio phone number in E.164 format, e.g. `+15551234567` |
| `GROK_API_KEY` | xAI API key — starts with `xai-` |
| `WEBHOOK_BASE_URL` | Public HTTPS base URL Twilio will POST to, e.g. `https://abc123.ngrok.io` |
| `WS_BASE_URL` | Public WSS base URL for the Twilio media stream, e.g. `wss://abc123.ngrok.io` |
| `PORT` | Local port (default `3000`) |
| `CALL_TIME_LIMIT_SECONDS` | Maximum call duration in seconds (default `300`) |

`WEBHOOK_BASE_URL` and `WS_BASE_URL` must be defined separately — the server never derives one from the other.

### ngrok (local development)

```sh
ngrok http 3000
```

Copy the `https://…ngrok.io` URL into `WEBHOOK_BASE_URL`, and the same hostname with `wss://` into `WS_BASE_URL`.

## Running

```sh
bun run dev   # hot-reload dev server on http://localhost:3000
```

## Commands

```sh
bun install              # install dependencies
bun run dev              # start dev server with hot reload
bun run lint             # run Biome linter
bun run lint:fix         # auto-fix lint issues
bun run generate:client  # regenerate TypeScript SDK from OpenAPI spec
                         # output: ../voice-ai-client/src/api/
```

## API

| Method | Path | Description |
|---|---|---|
| `POST` | `/calls` | Start an outbound call |
| `GET` | `/sessions/:id` | Poll session state and current pending question |
| `POST` | `/sessions/:id/answer` | Submit an answer to a pending question |
| `POST` | `/sessions/:id/end` | Forcibly end a call |

Full OpenAPI spec is served at `/doc` when the server is running.

## Architecture

```
src/
  domain/         Session entity and status types
  repository/     Abstract contracts (SessionRepository, CallGateway, RealtimeAIClient, MediaSink)
  service/        CallService + CallBridge — orchestration, no HTTP/Twilio/Grok imports
  api/
    routes/       Public REST API (OpenAPIHono)
    webhooks/     Twilio voice webhook + media stream WebSocket handler
    middleware.ts Hono DI middleware
  infrastructure/ Concrete implementations (InMemorySessionRepository, TwilioCallGateway, GrokRealtimeAdapter)
  index.ts        Composition root — wires all layers
```
