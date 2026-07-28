import {
	externalServiceErrorFromResponse,
	normalizeExternalServiceError,
} from "../utils/errors";
import { logger as defaultLogger, type Logger } from "../utils/logger";

const DISCORD_API_BASE = "https://discord.com/api/v10";

export class DiscordWebhookClient {
	private endpoint: string;
	private log: Logger;

	constructor(applicationId: string, token: string, log?: Logger) {
		this.endpoint = `${DISCORD_API_BASE}/webhooks/${applicationId}/${token}`;
		this.log = log ?? defaultLogger;
	}

	/**
	 * Edit the original deferred response message (PATCH).
	 * Used for streaming updates.
	 */
	async editOriginalMessage(content: string): Promise<void> {
		try {
			const res = await fetch(`${this.endpoint}/messages/@original`, {
				method: "PATCH",
				body: JSON.stringify({ content }),
				headers: { "Content-Type": "application/json" },
			});

			if (res.ok) {
				return;
			}

			throw externalServiceErrorFromResponse(
				"discord",
				"edit original message",
				res,
				"Discordへの応答送信に失敗しました。",
			);
		} catch (error) {
			throw normalizeExternalServiceError(error, {
				service: "discord",
				operation: "edit original message",
				userMessage: "Discordへの応答送信に失敗しました。",
			});
		}
	}

	/**
	 * Post a new message to the webhook (POST).
	 * Used for sending responses (e.g., error messages).
	 * Throws on failure.
	 */
	async postMessage(content: string): Promise<void> {
		try {
			const res = await fetch(this.endpoint, {
				method: "POST",
				body: JSON.stringify({ content }),
				headers: { "Content-Type": "application/json" },
			});

			if (!res.ok) {
				throw externalServiceErrorFromResponse(
					"discord",
					"post message",
					res,
					"Discordへのメッセージ送信に失敗しました。",
				);
			}

			this.log.info("Discord POST succeeded", { statusCode: res.status });
		} catch (error) {
			throw normalizeExternalServiceError(error, {
				service: "discord",
				operation: "post message",
				userMessage: "Discordへのメッセージ送信に失敗しました。",
			});
		}
	}
}

export const createDiscordWebhookClient = (
	applicationId: string,
	token: string,
	log?: Logger,
): DiscordWebhookClient => {
	return new DiscordWebhookClient(applicationId, token, log);
};
