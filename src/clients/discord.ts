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
	 * Non-fatal: logs warnings but does not throw on failure.
	 */
	async editOriginalMessage(content: string): Promise<boolean> {
		try {
			const res = await fetch(`${this.endpoint}/messages/@original`, {
				method: "PATCH",
				body: JSON.stringify({ content }),
				headers: { "Content-Type": "application/json" },
			});

			if (res.ok) {
				return true;
			}

			if (res.status === 429) {
				const retryAfter = res.headers.get("Retry-After");
				const waitMs = retryAfter ? Number.parseFloat(retryAfter) * 1000 : 2000;
				this.log.warn("Discord rate limited, waiting", { waitMs });
				await new Promise((resolve) => setTimeout(resolve, waitMs));
			} else {
				this.log.warn("Discord PATCH failed", { statusCode: res.status });
			}

			return false;
		} catch (error) {
			this.log.warn("Discord PATCH error", {
				error: error instanceof Error ? error.message : "Unknown error",
			});
			return false;
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
