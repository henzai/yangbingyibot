import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("discord-interactions", () => ({
	verifyKey: vi.fn().mockResolvedValue(true),
	InteractionType: {
		PING: 1,
		APPLICATION_COMMAND: 2,
	},
	InteractionResponseType: {
		PONG: 1,
		DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
	},
}));

vi.mock("./utils/requestId", () => ({
	generateRequestId: vi.fn().mockReturnValue("req_test_123"),
}));

vi.mock("discord-api-types/v10", () => ({
	ApplicationCommandOptionType: {
		String: 3,
	},
	InteractionType: {
		ApplicationCommand: 2,
	},
	InteractionResponseType: {
		ChannelMessageWithSource: 4,
	},
}));

import type { Bindings, WorkflowParams } from "./contracts";
import { app } from "./index";

const mockWorkflowCreate = vi.fn();

const mockEnv: Bindings = {
	DISCORD_TOKEN: "test-token",
	DISCORD_PUBLIC_KEY: "test-public-key",
	DISCORD_APPLICATION_ID: "test-app-id",
	GEMINI_API_KEY: "test-gemini-key",
	GOOGLE_SERVICE_ACCOUNT: '{"type":"service_account"}',
	sushanshan_bot: {} as KVNamespace,
	ANSWER_QUESTION_WORKFLOW: {
		create: mockWorkflowCreate,
	} as unknown as Workflow<WorkflowParams>,
};

const mockExecutionCtx = {
	waitUntil: () => {},
	passThroughOnException: () => {},
} as unknown as ExecutionContext;

type ErrorResponseBody = {
	data: {
		embeds: Array<{
			description?: string;
		}>;
	};
};

function postRequest(body: unknown) {
	return new Request("http://localhost/", {
		method: "POST",
		headers: {
			"X-Signature-Ed25519": "valid-sig",
			"X-Signature-Timestamp": "1234567890",
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
}

function guildAskInteraction(question = "What is this?") {
	return {
		type: 2,
		token: "interaction-token",
		guild_id: "guild-123",
		channel_id: "channel-123",
		member: {
			user: {
				id: "user-123",
			},
		},
		data: {
			name: "ask",
			options: [
				{ name: "ignored", type: 3, value: "not the question" },
				{ name: "question", type: 3, value: question },
			],
		},
	};
}

describe("index", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("GET /", () => {
		it("returns hello message", async () => {
			const req = new Request("http://localhost/");
			const res = await app.fetch(req, mockEnv, mockExecutionCtx);

			expect(res.status).toBe(200);
			expect(await res.text()).toBe("Hello Cloudflare Workers!");
		});
	});

	describe("POST / PING", () => {
		it("responds with PONG", async () => {
			const res = await app.fetch(
				postRequest({ type: 1 }),
				mockEnv,
				mockExecutionCtx,
			);

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ type: 1 });
		});
	});

	describe("POST / APPLICATION_COMMAND", () => {
		it("creates workflow and returns deferred response", async () => {
			mockWorkflowCreate.mockResolvedValue(undefined);

			const res = await app.fetch(
				postRequest(guildAskInteraction()),
				mockEnv,
				mockExecutionCtx,
			);

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ type: 5 });
			expect(mockWorkflowCreate).toHaveBeenCalledWith({
				params: {
					token: "interaction-token",
					message: "What is this?",
					requestId: "req_test_123",
					conversationKey: expect.stringMatching(/^[0-9a-f]{64}$/),
				},
			});
			expect(
				JSON.stringify(mockWorkflowCreate.mock.calls[0]?.[0]?.params),
			).not.toContain("user-123");
		});

		it("returns error response for an invalid command payload", async () => {
			const res = await app.fetch(
				postRequest({
					...guildAskInteraction(),
					data: { name: "other", options: [] },
				}),
				mockEnv,
				mockExecutionCtx,
			);

			expect(res.status).toBe(200);
			const json = (await res.json()) as ErrorResponseBody;
			expect(json.data.embeds[0].description).toBe(
				"Invalid Discord interaction: invalid command",
			);
		});

		it("returns error response when workflow creation fails", async () => {
			mockWorkflowCreate.mockRejectedValue(new Error("workflow error"));

			const res = await app.fetch(
				postRequest(guildAskInteraction("question")),
				mockEnv,
				mockExecutionCtx,
			);

			expect(res.status).toBe(200);
			const json = (await res.json()) as ErrorResponseBody;
			expect(json.data.embeds[0].description).toBe(
				"Failed to start processing",
			);
		});
	});

	describe("POST / invalid interaction type", () => {
		it("returns error response for unknown type", async () => {
			const res = await app.fetch(
				postRequest({ type: 999 }),
				mockEnv,
				mockExecutionCtx,
			);

			expect(res.status).toBe(200);
			const json = (await res.json()) as ErrorResponseBody;
			expect(json.data.embeds[0].description).toBe("Invalid interaction type");
		});
	});
});
