import {
	externalServiceErrorFromResponse,
	normalizeExternalServiceError,
} from "../utils/errors";
import { logger as defaultLogger, type Logger } from "../utils/logger";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const SUPPRESS_EMBEDS = 1 << 2;

export type DiscordWebhookClientOptions = {
	/** Disable all mention parsing and link embeds (sheet tool answers). */
	inert?: boolean;
	/** Aborts in-flight requests at the caller's deadline. */
	signal?: AbortSignal;
};

export class DiscordWebhookClient {
	private endpoint: string;
	private log: Logger;
	private options: DiscordWebhookClientOptions;

	constructor(
		applicationId: string,
		token: string,
		log?: Logger,
		options: DiscordWebhookClientOptions = {},
	) {
		this.endpoint = `${DISCORD_API_BASE}/webhooks/${applicationId}/${token}`;
		this.log = log ?? defaultLogger;
		this.options = options;
	}

	private body(content: string): string {
		return JSON.stringify(
			this.options.inert
				? {
						content,
						allowed_mentions: { parse: [] },
						flags: SUPPRESS_EMBEDS,
					}
				: { content },
		);
	}

	/**
	 * Edit the original deferred response message (PATCH).
	 * Used for streaming updates.
	 */
	async editOriginalMessage(content: string): Promise<void> {
		try {
			const res = await fetch(`${this.endpoint}/messages/@original`, {
				method: "PATCH",
				body: this.body(content),
				headers: { "Content-Type": "application/json" },
				signal: this.options.signal,
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
				body: this.body(content),
				headers: { "Content-Type": "application/json" },
				signal: this.options.signal,
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
	options?: DiscordWebhookClientOptions,
): DiscordWebhookClient => {
	return new DiscordWebhookClient(applicationId, token, log, options);
};
