import { Hono } from 'hono';
import { verifyDiscordInteraction } from './middleware/verifyDiscordInteraction';
import { InteractionType, InteractionResponseType } from 'discord-interactions';
import { errorResponse } from './responses/errorResponse';
import { Bindings } from './types';
import { logger } from './utils/logger';
import { generateRequestId } from './utils/requestId';

// Re-export the Workflow class for Cloudflare to discover
export { AnswerQuestionWorkflow } from './workflows/answerQuestionWorkflow';

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
	const requestId = generateRequestId();
	const log = logger.withContext({ requestId });

	try {
		switch (body.type) {
			// CRITICAL: Discord Interactions Endpoint Requirement
			// DO NOT REMOVE: Discord sends PING (type=1) requests to verify endpoint availability
			// and requires PONG (type=1) response for successful verification.
			// Removing this will cause Discord to reject the interactions endpoint.
			// Reference: https://discord.com/developers/docs/interactions/receiving-and-responding#receiving-an-interaction
			case InteractionType.PING:
				return c.json({ type: InteractionResponseType.PONG });
			case InteractionType.APPLICATION_COMMAND:
				// Validate payload structure
				const { question } = validateDiscordCommand(body);

				// Start the workflow
				log.info('Starting AnswerQuestionWorkflow', { messageLength: question.length });

				try {
					await c.env.ANSWER_QUESTION_WORKFLOW.create({
						params: {
							token: body.token,
							message: question,
							requestId,
						},
					});
				} catch (workflowError) {
					log.error('Failed to create workflow', {
						error: workflowError instanceof Error ? workflowError.message : 'Unknown error',
					});
					throw new Error('Failed to start processing');
				}

				return c.json({
					type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
				});
			default:
				throw new Error('Invalid interaction type');
		}
	} catch (e) {
		// This catch only handles synchronous errors before deferred response
		log.error('Request failed', { error: e instanceof Error ? e.message : 'Unknown error' });
		return c.json(errorResponse(e instanceof Error ? e.message : 'Unknown error'));
	}
});

export default app;
