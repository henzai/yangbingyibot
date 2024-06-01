import { Hono } from 'hono';
import { verifyDiscordInteraction } from './middleware/verifyDiscordInteraction';
import { InteractionType, InteractionResponseType } from 'discord-interactions';
import { errorResponse } from './responses/errorResponse';
import { Bindings } from './types';
import { GeminiClient } from './clients/gemini';
import { getSheetInfo } from './clients/spreadSheet';

const app = new Hono<{ Bindings: Bindings }>();

app.get('/', (c) => c.text('Hello Cloudflare Workers!'));

app.post('/', verifyDiscordInteraction, async (c) => {
	const body = await c.req.json();
	try {
		switch (body.type) {
			case InteractionType.APPLICATION_COMMAND:
				//　時間がかかるので先にレスポンスを返す
				c.executionCtx.waitUntil(handleRequest(body.data.options[0].value, body.token, c.env));
				return c.json({
					type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
				});
			default:
				throw new Error('Invalid interaction');
		}
	} catch (e) {
		return c.json(errorResponse(e instanceof Error ? e.message : 'Unknown error'));
	}
});

async function handleRequest(message: string, token: string, env: Bindings) {
	try {
		const sheet = await getSheetInfo(env.GOOGLE_SERVICE_ACCOUNT, env.sushanshan_bot);
		const llm = new GeminiClient(env.GEMINI_API_KEY);
		const result = await llm.ask(message, sheet);
		const endpoint = `https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${token}`;
		await fetch(endpoint, {
			method: 'POST',
			body: JSON.stringify({
				content: `> ${message}\n${result}`,
			}),
			headers: {
				'Content-Type': 'application/json',
			},
		});
	} catch (error) {
		const endpoint = `https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${token}`;
		await fetch(endpoint, {
			method: 'POST',
			body: JSON.stringify({
				content: `> ${error instanceof Error ? error.message : 'Unknown error'}`,
			}),
			headers: {
				'Content-Type': 'application/json',
			},
		});
	}
}

export default app;
