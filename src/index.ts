import { Hono } from 'hono';
import { verifyDiscordInteraction } from './middleware/verifyDiscordInteraction';
import { InteractionType, InteractionResponseType } from 'discord-interactions';
import { errorResponse } from './responses/errorResponse';
import { Bindings } from './types';
import { answerQuestion } from './handlers/answerQuestion';
import { logger } from './utils/logger';

const app = new Hono<{ Bindings: Bindings }>();

// Validate Discord command payload structure
function validateDiscordCommand(body: any): { question: string } {
	if (!body?.data) {
		throw new Error('Invalid Discord interaction: missing data');
	}

	if (!Array.isArray(body.data.options) || body.data.options.length === 0) {
		throw new Error('Invalid Discord interaction: missing options');
	}

	const question = body.data.options[0]?.value;
	if (typeof question !== 'string' || !question.trim()) {
		throw new Error('Invalid Discord interaction: question must be a non-empty string');
	}

	return { question: question.trim() };
}

app.get('/', (c) => c.text('Hello Cloudflare Workers!'));

app.post('/', verifyDiscordInteraction, async (c) => {
	const body = await c.req.json();
	try {
		switch (body.type) {
			case InteractionType.PING:
				return c.json({ type: InteractionResponseType.PONG });
			case InteractionType.APPLICATION_COMMAND:
				// Validate payload structure
				const { question } = validateDiscordCommand(body);

				// Schedule async processing with proper error isolation
				c.executionCtx.waitUntil(
					handleDiscordResponse(question, body.token, c.env).catch((error) => {
						// Log error but don't throw - waitUntil failures are silent
						console.error('Fatal error in async processing:', error);
					})
				);

				return c.json({
					type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
				});
			default:
				throw new Error('Invalid interaction type');
		}
	} catch (e) {
		// This catch only handles synchronous errors before deferred response
		return c.json(errorResponse(e instanceof Error ? e.message : 'Unknown error'));
	}
});

async function handleDiscordResponse(message: string, token: string, env: Bindings) {
	const endpoint = `https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${token}`;

	logger.info('Processing Discord interaction', { messageLength: message.length });

	// Helper to send webhook with retry
	async function sendWebhook(content: string, retries = 2): Promise<void> {
		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				const response = await fetch(endpoint, {
					method: 'POST',
					body: JSON.stringify({ content }),
					headers: { 'Content-Type': 'application/json' },
				});

				if (!response.ok) {
					const errorText = await response.text();
					throw new Error(`Discord webhook failed (${response.status}): ${errorText}`);
				}

				return; // Success
			} catch (error) {
				if (attempt === retries) {
					// Last attempt failed
					console.error('All webhook retry attempts failed:', error);
					throw error;
				}
				// Wait before retry (exponential backoff)
				await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1000));
			}
		}
	}

	try {
		const result = await answerQuestion(message, env);
		await sendWebhook(`> ${message}\n${result}`);
		logger.info('Successfully processed interaction', {
			messageLength: message.length,
			resultLength: result.length,
		});
	} catch (error) {
		// Try to send error message to user
		const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';

		logger.error('Failed to process interaction', {
			error: errorMessage,
			messageLength: message.length,
		});

		try {
			await sendWebhook(`> ${message}\n🚨 エラーが発生しました: ${errorMessage}`);
		} catch (webhookError) {
			// Even error reporting failed - log and give up
			logger.error('Failed to report error to user via webhook', {
				webhookError: webhookError instanceof Error ? webhookError.message : 'Unknown',
				originalError: errorMessage,
			});
		}

		// Don't re-throw - we're in waitUntil, throwing does nothing
	}
}

export default app;
