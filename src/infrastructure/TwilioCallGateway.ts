// ─── INFRASTRUCTURE LAYER ────────────────────────────────────────────────────
// Implements CallGateway using the Twilio REST API.
// Twilio places the call and, once connected, POSTs to our webhook URL
// to fetch TwiML instructions (handled by twilioRouter).
// ─────────────────────────────────────────────────────────────────────────────

import type { Twilio } from "twilio";
import type { CallGateway } from "../repository";

export class TwilioCallGateway implements CallGateway {
	constructor(
		private readonly client: Twilio,
		private readonly fromNumber: string, // the Twilio phone number to call from
	) {}

	async placeCall(input: {
		to: string;
		webhookUrl: string; // Twilio will POST here when the call connects
		statusCallbackUrl: string; // Twilio POSTs terminal call events here
		timeLimitSeconds?: number;
	}): Promise<{ providerCallId: string }> {
		const call = await this.client.calls.create({
			to: input.to,
			from: this.fromNumber,
			url: input.webhookUrl,
			statusCallback: input.statusCallbackUrl,
			statusCallbackMethod: "POST",
			timeLimit: input.timeLimitSeconds,
		});
		// call.sid is Twilio's unique identifier for this call (e.g. "CAxxxxxxx").
		return { providerCallId: call.sid };
	}

	async hangUpCall(providerCallId: string): Promise<void> {
		await this.client.calls(providerCallId).update({ status: "completed" });
	}
}
