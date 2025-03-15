import { Hono } from 'hono';
import { verifyDiscordInteraction } from './middleware/verifyDiscordInteraction';
import { InteractionType, InteractionResponseType } from 'discord-interactions';
import { errorResponse } from './responses/errorResponse';
import { Bindings } from './types';
import { answerQuestion } from './handlers/answerQuestion';

const app = new Hono<{ Bindings: Bindings }>();

app.get('/', (c) => c.text('Hello Cloudflare Workers!'));

app.post('/', verifyDiscordInteraction, async (c) => {
	const body = await c.req.json();
	try {
		switch (body.type) {
			case InteractionType.APPLICATION_COMMAND:
				//　時間がかかるので先にレスポンスを返す
				c.executionCtx.waitUntil(handleDiscordResponse(body.data.options[0].value, body.token, c.env));
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

async function handleDiscordResponse(message: string, token: string, env: Bindings) {
	const endpoint = `https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${token}`;
	try {
		const result = await answerQuestion(message, env);
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
		await fetch(endpoint, {
			method: 'POST',
			body: JSON.stringify({
				content: `> ${error instanceof Error ? error.message : 'Unknown error'}`,
			}),
			headers: {
				'Content-Type': 'application/json',
			},
		});
		throw error;
	}
}

export default app;
