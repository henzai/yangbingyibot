import { InteractionResponseType, InteractionType } from "discord-interactions";
import { Hono } from "hono";
import { loadConfig } from "./config";
import type { Bindings } from "./contracts";
import {
	getInteractionType,
	parseDiscordAskCommand,
} from "./discord/interaction";
import { runHealthCheck } from "./health";
import { verifyDiscordInteraction } from "./middleware/verifyDiscordInteraction";
import { errorResponse } from "./responses/errorResponse";
import { logger } from "./utils/logger";
import { generateRequestId } from "./utils/requestId";

// Re-export the Workflow class for Cloudflare to discover
export { AnswerQuestionWorkflow } from "./workflows/answerQuestionWorkflow";

const app = new Hono<{ Bindings: Bindings }>();

app.get("/", (c) => c.text("Hello Cloudflare Workers!"));

app.post("/", verifyDiscordInteraction, async (c) => {
	const requestId = generateRequestId();
	const log = logger.withContext({ requestId });

	try {
		const body: unknown = await c.req.json();
		switch (getInteractionType(body)) {
			// CRITICAL: Discord Interactions Endpoint Requirement
			// DO NOT REMOVE: Discord sends PING (type=1) requests to verify endpoint availability
			// and requires PONG (type=1) response for successful verification.
			// Removing this will cause Discord to reject the interactions endpoint.
			// Reference: https://discord.com/developers/docs/interactions/receiving-and-responding#receiving-an-interaction
			case InteractionType.PING:
				return c.json({ type: InteractionResponseType.PONG });
			case InteractionType.APPLICATION_COMMAND: {
				// Fail fast at the request boundary before creating a Workflow.
				loadConfig(c.env);
				const { token, question, conversationKey } =
					await parseDiscordAskCommand(body);

				// Start the workflow
				log.info("Starting AnswerQuestionWorkflow", {
					messageLength: question.length,
				});

				try {
					await c.env.ANSWER_QUESTION_WORKFLOW.create({
						params: {
							token,
							message: question,
							requestId,
							conversationKey,
						},
					});
				} catch (workflowError) {
					log.error("Failed to create workflow", {
						error:
							workflowError instanceof Error
								? workflowError.message
								: "Unknown error",
					});
					throw new Error("Failed to start processing");
				}

				return c.json({
					type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
				});
			}
			default:
				throw new Error("Invalid interaction type");
		}
	} catch (e) {
		// This catch only handles synchronous errors before deferred response
		log.error("Request failed", {
			error: e instanceof Error ? e.message : "Unknown error",
		});
		return c.json(
			errorResponse(e instanceof Error ? e.message : "Unknown error"),
		);
	}
});

export { app };

export default {
	fetch: app.fetch,
	scheduled: async (
		_event: ScheduledEvent,
		env: Bindings,
		ctx: ExecutionContext,
	) => {
		const log = logger.withContext({ trigger: "scheduled" });
		log.info("Cron health check started");
		ctx.waitUntil(runHealthCheck(env, log));
	},
};
