// ─── INFRASTRUCTURE LAYER ────────────────────────────────────────────────────
// Implements RealtimeAIClient by connecting to the xAI Grok Realtime API.
//
// How it works:
//   1. open() opens a WebSocket to Grok
//   2. On connect, sends session.update to configure tools + VAD
//   3. Sends response.create to prompt Grok to start speaking
//   4. Returns a RealtimeAISession handle to the caller (CallBridge)
//   5. All subsequent audio and events flow through that session object
//
// Audio transcoding:
//   Grok's session.update accepts output_audio_format:"pcmu" and session.updated
//   confirms it, but the actual audio deltas are PCM16 LE at 24 kHz — verified
//   empirically: first delta bytes are 0x00 0x00 (int16LE=0, i.e. silence), not
//   the 0xFF/0x7F a mulaw encoder would produce for silence. In mulaw, 0x00 is
//   maximum negative clipping. Omit audio format fields from session.update and
//   transcode in both directions:
//     Twilio → us  : mulaw 8 kHz  →  PCM16 24 kHz  (upsample 1:3 + decode)
//     Grok   → us  : PCM16 24 kHz →  mulaw 8 kHz   (downsample 3:1 + encode)
// ─────────────────────────────────────────────────────────────────────────────

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	FunctionCallEvent,
	RealtimeAIClient,
	RealtimeAISession,
	ToolSpec,
} from "../repository";

const GROK_REALTIME_URL = "wss://api.x.ai/v1/realtime?model=grok-voice-latest";

const LOG_FILE = join(import.meta.dir, "../../grok.log");
// Truncate on server start so each run gets a clean file.
writeFileSync(
	LOG_FILE,
	`=== grok log started ${new Date().toISOString()} ===\n`,
);

function glog(msg: string): void {
	const line = `${new Date().toISOString()} ${msg}\n`;
	process.stdout.write(line);
	appendFileSync(LOG_FILE, line);
}

// ── G.711 μ-law ↔ PCM16 transcoding ─────────────────────────────────────────

function linearToMulaw(pcm: number): number {
	const BIAS = 0x84;
	const CLIP = 32635;
	const sign = pcm < 0 ? 0x80 : 0;
	if (pcm < 0) pcm = -pcm;
	if (pcm > CLIP) pcm = CLIP;
	pcm += BIAS;
	let exp = 7;
	let mask = 0x4000;
	while (exp > 0 && (pcm & mask) === 0) {
		exp--;
		mask >>= 1;
	}
	const mantissa = (pcm >> (exp + 3)) & 0x0f;
	return ~(sign | (exp << 4) | mantissa) & 0xff;
}

function mulawToLinear(mu: number): number {
	mu = ~mu & 0xff;
	const sign = mu & 0x80;
	const exp = (mu >> 4) & 0x07;
	const mantissa = mu & 0x0f;
	let sample = ((mantissa << 1) + 33) << (exp + 2);
	sample -= 33;
	return sign ? -sample : sample;
}

// PCM16 LE 24 kHz → mulaw 8 kHz  (3:1 average decimation)
function pcm16_24k_to_mulaw_8k(b64: string): string {
	const bytes = Buffer.from(b64, "base64");
	const samples = bytes.length >> 1; // number of PCM16 samples
	const outLen = Math.floor(samples / 3);
	const out = Buffer.allocUnsafe(outLen);
	for (let i = 0; i < outLen; i++) {
		const off = i * 6;
		const s0 = bytes.readInt16LE(off);
		const s1 = bytes.readInt16LE(off + 2);
		const s2 = bytes.readInt16LE(off + 4);
		out[i] = linearToMulaw(Math.round((s0 + s1 + s2) / 3));
	}
	return out.toString("base64");
}

// mulaw 8 kHz → PCM16 LE 24 kHz  (1:3 nearest-neighbour upsample)
function mulaw_8k_to_pcm16_24k(b64: string): string {
	const bytes = Buffer.from(b64, "base64");
	const out = Buffer.allocUnsafe(bytes.length * 6);
	for (let i = 0; i < bytes.length; i++) {
		const sample = mulawToLinear(bytes[i]);
		const off = i * 6;
		out.writeInt16LE(sample, off);
		out.writeInt16LE(sample, off + 2);
		out.writeInt16LE(sample, off + 4);
	}
	return out.toString("base64");
}

// ─────────────────────────────────────────────────────────────────────────────

export class GrokRealtimeAdapter implements RealtimeAIClient {
	constructor(private readonly apiKey: string) {}

	open(options: {
		instructions: string;
		tools: ToolSpec[];
		audioFormat?: "mulaw8k" | "pcm16_24k";
		greetingInstructions?: string;
	}): Promise<RealtimeAISession> {
		const audioFormat = options.audioFormat ?? "mulaw8k";
		// We wrap the WebSocket setup in a Promise so the caller can await it.
		// The promise resolves once the connection is open and Grok is configured.
		// It rejects if the connection fails before that point.
		return new Promise((resolve, reject) => {
			// Bun extends the standard WebSocket constructor to accept an options
			// object as the second argument, supporting custom headers for auth.
			const ws = new WebSocket(GROK_REALTIME_URL, {
				headers: { Authorization: `Bearer ${this.apiKey}` },
			});

			// Tracks response IDs where a request_user_input tool call was detected.
			// Audio for these responses is suppressed so the question is never spoken.
			const responsesWithFunctionCall = new Set<string>();

			// Once the 1500 ms buffer window has elapsed (timer fired), subsequent
			// audio deltas for the same response are forwarded immediately instead of
			// re-buffered. This prevents choppy playback on long responses where the
			// timer fires mid-stream and creates audible gaps between batches.
			const responsesInStreamingMode = new Set<string>();

			// Accumulates the output audio transcript per response so we can detect
			// voiced questions (text ending with "?") and suppress them at response.done
			// even when no tool call fired in that response.
			const transcripts = new Map<string, string>();

			// The responseId of the greeting (first response). Tracked so early-?
			// suppression never fires for it, even if the 1500ms timer sets
			// greetingPlayed=true just before a '?' delta arrives.
			let greetingResponseId: string | null = null;

			// The first response must always play — it contains the opening greeting
			// that establishes the call. Only subsequent responses are subject to
			// question suppression.
			let greetingPlayed = false;

			// Prevents correction injection loops. Set to true after the first
			// correction is injected; cleared when the business speaks again
			// (input_audio_buffer.speech_started). Without this, each voiced response
			// after a correction triggers another correction → infinite loop.
			let correctionActive = false;

			// Tracks whether the most recent business utterance contained a question.
			// Used to detect the case where Grok voices employer-directed speech
			// ("let me check. The business is asking…") instead of calling
			// request_user_input — no '?' in AI transcript, no tool call, but
			// the tool was clearly required.
			let lastBusinessHadQuestion = false;

			// Set when request_user_input fires; cleared when the employer submits
			// an answer (sendFunctionResult). Prevents duplicate corrections when
			// the business speaks again ("Hello?") while the employer is still typing.
			let toolCallPending = false;

			// Responses where employer-directed speech ("The business is asking…")
			// was detected mid-stream and audio was suppressed early. Unlike
			// responsesWithFunctionCall, these responses still trigger the
			// tool-required correction at response.done.
			const employerSpeechSuppressed = new Set<string>();

			// Phrases that signal Grok is speaking to the employer instead of calling
			// request_user_input. Detected in streaming transcript deltas so the audio
			// can be suppressed before it reaches the business.
			const EMPLOYER_PHRASES = [
				"the business is asking",
				"the business asked",
				"they are asking",
				"they want to know",
			];

			// Audio buffer per response. Audio is held before forwarding; if a
			// request_user_input function_call item arrives within AUDIO_BUFFER_MS,
			// the buffer is discarded. If the timer fires first, buffer is flushed.
			const AUDIO_BUFFER_MS = 1500;
			const audioBuffers = new Map<
				string,
				{ chunks: string[]; timer: ReturnType<typeof setTimeout> }
			>();

			function isQuestion(responseId: string): boolean {
				const text = transcripts.get(responseId) ?? "";
				return text.includes("?");
			}

			// Word-boundary / full-phrase regexes to avoid false positives on
			// mid-sentence substrings like "talk to you about the order" or
			// "you have a good point".
			const GOODBYE_REGEXES: RegExp[] = [
				/\bgoodbye\b/,
				/\bbye\b/,
				/\btake care\b/,
				/have a good day/,
				/have a great day/,
				/talk to you (later|soon)/,
				/thanks for calling/,
				/thank you for calling/,
			];

			function isGoodbye(transcript: string): boolean {
				const text = transcript.toLowerCase();
				return GOODBYE_REGEXES.some((r) => r.test(text));
			}

			function flushAudioBuffer(responseId: string): void {
				const entry = audioBuffers.get(responseId);
				if (!entry) return;
				audioBuffers.delete(responseId);
				// Timer fired — subsequent audio for this response can skip buffering.
				responsesInStreamingMode.add(responseId);
				// Mark first response as processed regardless of tool calls — without
				// this, a greeting that triggers a function call returns early and
				// greetingPlayed stays false, disabling question suppression forever.
				const wasGreeting = !greetingPlayed;
				if (wasGreeting) {
					greetingPlayed = true;
					greetingResponseId = responseId;
				}
				if (responsesWithFunctionCall.has(responseId)) return;
				// Suppress voiced questions on non-greeting responses only.
				// The greeting always plays — wasGreeting bypasses the question check.
				if (!wasGreeting && isQuestion(responseId)) {
					glog(
						`[grok] audio suppressed (voiced question) rid=${responseId} transcript="${transcripts.get(responseId)}"`,
					);
					return;
				}
				for (const chunk of entry.chunks) handlers.audio?.(chunk);
			}

			// Single-slot handler storage. onAudio/onFunctionCall/onClose register
			// a callback here; the WebSocket message handler calls it.
			// Using null instead of an array because each session only ever has
			// one subscriber for each event type (the CallBridge).
			const handlers = {
				audio: null as ((base64: string) => void) | null,
				functionCall: null as ((event: FunctionCallEvent) => void) | null,
				close: null as (() => void) | null,
			};

			// The session object is the public interface returned to CallBridge.
			// It captures `ws` and `handlers` in its closure.
			const session: RealtimeAISession = {
				// Append a chunk of caller audio to Grok's input buffer.
				// Twilio sends mulaw 8 kHz → transcode to PCM16 24 kHz.
				// Browser sends PCM16 24 kHz directly → no transcoding needed.
				sendAudio(base64: string) {
					if (ws.readyState !== WebSocket.OPEN) return;
					ws.send(
						JSON.stringify({
							type: "input_audio_buffer.append",
							audio:
								audioFormat === "mulaw8k"
									? mulaw_8k_to_pcm16_24k(base64)
									: base64,
						}),
					);
				},

				// Submit the result of a tool call back to Grok so it can continue.
				// Two messages are required:
				//   1. conversation.item.create — delivers the function output
				//   2. response.create — tells Grok to generate a response using it
				sendFunctionResult(callId: string, outputJson: string) {
					if (ws.readyState !== WebSocket.OPEN) return;
					toolCallPending = false; // employer answered — allow new corrections
					ws.send(
						JSON.stringify({
							type: "conversation.item.create",
							item: {
								type: "function_call_output",
								call_id: callId,
								output: outputJson,
							},
						}),
					);
					ws.send(JSON.stringify({ type: "response.create" }));
				},

				onAudio(handler) {
					handlers.audio = handler;
				},

				onFunctionCall(handler) {
					handlers.functionCall = handler;
				},

				onClose(handler) {
					handlers.close = handler;
				},

				close() {
					ws.close();
				},
			};

			ws.addEventListener("open", () => {
				// Configure the session immediately on connect.
				// No audio format specified — Grok sends PCM16 24 kHz by default
				// (it claims mulaw support but actually sends PCM16; we transcode).
				// turn_detection server_vad: Grok detects when the caller stops speaking.
				ws.send(
					JSON.stringify({
						type: "session.update",
						session: {
							turn_detection: { type: "server_vad" },
							instructions: options.instructions,
							tools: options.tools.map((t) => ({
								type: "function",
								name: t.name,
								description: t.description,
								parameters: t.parameters,
							})),
						},
					}),
				);

				// Inject the greeting instruction as a conversation item so Grok
				// treats it the same way it treats correction injections — reliable
				// instruction-following rather than the unpredictable response.create
				// instructions field (which Grok sometimes echoes literally or doubles).
				if (options.greetingInstructions) {
					ws.send(
						JSON.stringify({
							type: "conversation.item.create",
							item: {
								type: "message",
								role: "user",
								content: [
									{
										type: "input_text",
										text: options.greetingInstructions,
									},
								],
							},
						}),
					);
				}
				ws.send(JSON.stringify({ type: "response.create" }));

				// Session is ready — resolve the promise so CallBridge can proceed.
				resolve(session);
			});

			ws.addEventListener("message", (event) => {
				let msg: Record<string, unknown>;
				try {
					msg = JSON.parse(event.data as string) as Record<string, unknown>;
				} catch {
					return;
				}

				// New business speech resets the correction guard so the next
				// voiced question after this turn can trigger a fresh correction.
				if (msg.type === "input_audio_buffer.speech_started") {
					correctionActive = false;
				}

				// Diagnostic logging — omit high-frequency audio delta events.
				const rid = (msg.response_id ??
					(msg.response as Record<string, unknown>)?.id) as string | undefined;
				if (msg.type !== "response.output_audio.delta") {
					glog(`[grok] ${msg.type} rid=${rid ?? "-"}`);
				}
				if (msg.type === "response.output_item.added") {
					const dbgItem = msg.item as Record<string, unknown>;
					glog(
						`[grok]   item type=${dbgItem?.type} name=${dbgItem?.name ?? "-"}`,
					);
				}
				if (
					msg.type === "conversation.item.input_audio_transcription.completed"
				) {
					const userSaid = (msg.transcript as string) ?? "";
					glog(`[grok]   user said: "${userSaid}"`);
					// True for any non-empty business speech — listing options or stating
					// details also requires request_user_input, not just explicit questions.
					lastBusinessHadQuestion = userSaid.trim().length > 0;
				}
				// Accumulate Grok's output audio transcript for question detection.
				if (msg.type === "response.output_audio_transcript.delta") {
					const responseId = msg.response_id as string;
					const delta = (msg.delta as string) ?? "";
					transcripts.set(
						responseId,
						(transcripts.get(responseId) ?? "") + delta,
					);
					// Early suppression: flush pre-marker audio (relay statements, "just a
					// second") then drop the rest when either:
					//   (a) '?' detected — voiced question to business (suppress + no correction)
					//   (b) employer-directed phrase detected — Grok speaking to employer
					//       aloud instead of calling the tool (suppress + let correction fire)
					// Skip the greeting (greetingPlayed=false) — it always plays regardless.
					const accumulated = transcripts.get(responseId) ?? "";
					const hasQuestion =
						greetingPlayed &&
						responseId !== greetingResponseId &&
						delta.includes("?") &&
						!responsesWithFunctionCall.has(responseId) &&
						!employerSpeechSuppressed.has(responseId);
					const hasEmployerPhrase =
						greetingPlayed &&
						!responsesWithFunctionCall.has(responseId) &&
						!employerSpeechSuppressed.has(responseId) &&
						EMPLOYER_PHRASES.some((p) => accumulated.toLowerCase().includes(p));

					if (hasQuestion || hasEmployerPhrase) {
						const entry = audioBuffers.get(responseId);
						if (entry) {
							clearTimeout(entry.timer);
							audioBuffers.delete(responseId);
						}
						if (hasQuestion) {
							// Only play pre-? audio when there is a completed relay sentence
							// before the '?' (contains '.' or '!'). Acknowledgment-only
							// responses ("let me check…") or partial employer-directed speech
							// should not play — the voiced-question correction handles them.
							const beforeQ = accumulated.replace(/\?.*$/, "");
							const hasCompleteRelay = /[.!]/.test(beforeQ);
							if (entry && hasCompleteRelay) {
								for (const chunk of entry.chunks) handlers.audio?.(chunk);
							}
							// Mark as handled — response.done skips the correction.
							responsesWithFunctionCall.add(responseId);
							glog(
								`[grok] audio flushed early at ? — ${hasCompleteRelay ? "relay played" : "suppressed (no relay)"} rid=${responseId}`,
							);
						} else {
							// Employer-directed phrase: discard buffered audio entirely —
							// don't play even "just a second" since the correction will
							// trigger a fresh tool call with its own acknowledgment.
							employerSpeechSuppressed.add(responseId);
							glog(
								`[grok] employer-directed speech suppressed early rid=${responseId}`,
							);
						}
					}
				}
				if (msg.type === "response.output_audio_transcript.done") {
					glog(
						`[grok]   transcript done: "${transcripts.get(rid ?? "") ?? ""}"`,
					);
				}

				// Buffer audio for each response; suppress if request_user_input fires.
				// For mulaw8k: transcode PCM16 24kHz → mulaw 8kHz before buffering.
				// For pcm16_24k: pass PCM16 24kHz directly (browser decodes natively).
				if (msg.type === "response.output_audio.delta") {
					const responseId = msg.response_id as string;
					const delta = msg.delta as string;
					if (
						delta &&
						!responsesWithFunctionCall.has(responseId) &&
						!employerSpeechSuppressed.has(responseId)
					) {
						const transcoded =
							audioFormat === "mulaw8k" ? pcm16_24k_to_mulaw_8k(delta) : delta;
						if (responsesInStreamingMode.has(responseId)) {
							// Past the detection window — forward immediately to avoid gaps.
							handlers.audio?.(transcoded);
						} else {
							const existing = audioBuffers.get(responseId);
							if (existing) {
								existing.chunks.push(transcoded);
							} else {
								const timer = setTimeout(
									() => flushAudioBuffer(responseId),
									AUDIO_BUFFER_MS,
								);
								audioBuffers.set(responseId, { chunks: [transcoded], timer });
								glog(`[grok] audio buffer started rid=${responseId}`);
							}
						}
					}
				}

				// request_user_input detected — cancel the buffer and suppress audio.
				// hang_up audio (goodbye) is intentionally not suppressed.
				else if (msg.type === "response.output_item.added") {
					const item = msg.item as Record<string, unknown>;
					if (
						item?.type === "function_call" &&
						item?.name === "request_user_input"
					) {
						lastBusinessHadQuestion = false; // tool was called — question handled
						toolCallPending = true;
						const responseId = msg.response_id as string;
						responsesWithFunctionCall.add(responseId);
						const entry = audioBuffers.get(responseId);
						if (entry) {
							clearTimeout(entry.timer);
							audioBuffers.delete(responseId);
							if (!greetingPlayed) {
								// Greeting audio must always reach the business even when a
								// tool call fires quickly (< 1500 ms). Play before suppressing.
								greetingPlayed = true;
								for (const chunk of entry.chunks) handlers.audio?.(chunk);
								glog(
									`[grok] greeting audio flushed before tool suppression rid=${responseId}`,
								);
							} else {
								glog(
									`[grok] audio suppressed (tool in buffer) rid=${responseId}`,
								);
							}
						} else {
							glog(
								`[grok] audio suppressed (tool, buffer already flushed) rid=${responseId}`,
							);
						}
					}
				} else if (msg.type === "response.done") {
					const responseId = (msg.response as Record<string, unknown>)
						?.id as string;
					if (responseId) {
						const hadFnCall = responsesWithFunctionCall.has(responseId);
						const wasEmployerSuppressed =
							employerSpeechSuppressed.has(responseId);
						const transcript = transcripts.get(responseId) ?? "";
						// Employer-suppressed responses never reach the business — don't treat
						// any '?' in their transcript as a voiced question.
						const voiced =
							!hadFnCall && !wasEmployerSuppressed && transcript.includes("?");
						glog(
							`[grok] response.done rid=${responseId} hasPendingBuffer=${audioBuffers.has(responseId)} hasFnCall=${hadFnCall} voiced=${voiced}`,
						);
						// Capture before flush — flushAudioBuffer sets greetingPlayed on
						// the first response, which would otherwise let goodbye-detection
						// fire on the opening greeting itself.
						const greetingWasPlayed = greetingPlayed;
						flushAudioBuffer(responseId);
						responsesWithFunctionCall.delete(responseId);
						employerSpeechSuppressed.delete(responseId);
						responsesInStreamingMode.delete(responseId);
						transcripts.delete(responseId);

						// Grok voiced a question without calling request_user_input.
						// The business didn't hear it (audio suppressed), but Grok thinks it
						// asked. Inject one correction per business turn — correctionActive
						// prevents re-injection loops where each correction triggers another
						// voiced response (seen as Grok speaking the tool-call syntax aloud).
						// greetingWasPlayed guard: the greeting always plays regardless of '?',
						// so don't inject a false "your response was muted" correction for it.
						if (
							voiced &&
							greetingWasPlayed &&
							responseId !== greetingResponseId &&
							ws.readyState === WebSocket.OPEN
						) {
							if (correctionActive) {
								glog(
									`[grok] voiced question but correction already active — skipping re-injection rid=${responseId}`,
								);
							} else {
								correctionActive = true;
								// Auto-clear after 10 s in case the business never speaks —
								// prevents permanent deadlock when correctionActive stays true.
								setTimeout(() => {
									correctionActive = false;
								}, 10000);
								glog(`[grok] injecting correction for voiced question`);
								ws.send(
									JSON.stringify({
										type: "conversation.item.create",
										item: {
											type: "message",
											role: "user",
											content: [
												{
													type: "input_text",
													text: "SYSTEM: Your last response was muted — the business did not hear it. You broke Rule 2 by asking the business a question. You are the CUSTOMER — never ask the business anything. Wait silently for the business to address you. Only call request_user_input if the business asked YOU a specific question that requires information from your employer. Do NOT invent any details (pizza type, name, quantity, etc.).",
												},
											],
										},
									}),
								);
								ws.send(JSON.stringify({ type: "response.create" }));
							}
						}

						// Grok voiced employer-directed speech ("let me check. The business
						// is asking…") instead of calling request_user_input. Detectable
						// as: business turn had '?', AI response had no tool call and no
						// voiced question of its own. Inject a direct "call the tool now"
						// correction — distinct from the voiced-question correction.
						if (
							!hadFnCall &&
							!voiced &&
							greetingWasPlayed &&
							lastBusinessHadQuestion &&
							!correctionActive &&
							!toolCallPending &&
							!isGoodbye(transcript) &&
							ws.readyState === WebSocket.OPEN
						) {
							correctionActive = true;
							setTimeout(() => {
								correctionActive = false;
							}, 10000);
							glog(
								`[grok] business asked but no tool call — injecting tool-required correction rid=${responseId}`,
							);
							ws.send(
								JSON.stringify({
									type: "conversation.item.create",
									item: {
										type: "message",
										role: "user",
										content: [
											{
												type: "input_text",
												text: "SYSTEM: The business just asked you a question. You MUST call request_user_input with the business's exact question. Do not say anything. Call the tool immediately.",
											},
										],
									},
								}),
							);
							ws.send(JSON.stringify({ type: "response.create" }));
						}

						// Grok said goodbye but forgot to call hang_up.
						// Detect goodbye phrases and synthesize a hang_up function call so
						// the call actually ends. Delay 2 s to let audio finish playing.
						if (
							!hadFnCall &&
							!voiced &&
							greetingWasPlayed &&
							isGoodbye(transcript)
						) {
							glog(
								`[grok] goodbye detected without hang_up — scheduling fallback rid=${responseId} transcript="${transcript}"`,
							);
							setTimeout(() => {
								glog("[grok] firing synthetic hang_up");
								handlers.functionCall?.({
									name: "hang_up",
									callId: "synthetic-hangup",
									arguments: "{}",
								});
							}, 2000);
						}
					}
				}

				// Grok finished generating all arguments for a tool call.
				// We use the "done" event (not intermediate streaming events) so we
				// get the complete argument JSON in one shot.
				else if (msg.type === "response.function_call_arguments.done") {
					handlers.functionCall?.({
						name: msg.name as string,
						callId: msg.call_id as string,
						arguments: msg.arguments as string,
					});
				}
			});

			ws.addEventListener("close", () => {
				handlers.close?.();
			});

			// Connection failed before the session was established — reject the promise.
			ws.addEventListener("error", (err) => {
				reject(err);
			});
		});
	}
}
