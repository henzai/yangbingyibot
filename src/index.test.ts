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
	InteractionResponseType: {
		ChannelMessageWithSource: 4,
	},
}));

import app from "./index";
import type { Bindings } from "./types";

const mockWorkflowCreate = vi.fn();

const mockEnv: Bindings = {
	DISCORD_TOKEN: "test-token",
	DISCORD_PUBLIC_KEY: "test-public-key",
	DISCORD_APPLICATION_ID: "test-app-id",
	GEMINI_API_KEY: "test-gemini-key",
	GOOGLE_SERVICE_ACCOUNT: '{"type":"service_account"}',
	sushanshan_bot: {} as KVNamespace,
	// biome-ignore lint/suspicious/noExplicitAny: mock binding for test
	ANSWER_QUESTION_WORKFLOW: { create: mockWorkflowCreate } as any,
};

const mockExecutionCtx = {
	waitUntil: () => {},
	passThroughOnException: () => {},
} as unknown as ExecutionContext;

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
				postRequest({
					type: 2,
					token: "interaction-token",
					data: {
						options: [{ value: "What is this?" }],
					},
				}),
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
				},
			});
		});

		it("returns error response when body.data is missing", async () => {
			const res = await app.fetch(
				postRequest({ type: 2, token: "t" }),
				mockEnv,
				mockExecutionCtx,
			);

			expect(res.status).toBe(200);
			const json = await res.json();
			expect(json.data.embeds[0].description).toBe(
				"Invalid Discord interaction: missing data",
			);
		});

		it("returns error response when options are missing", async () => {
			const res = await app.fetch(
				postRequest({ type: 2, token: "t", data: {} }),
				mockEnv,
				mockExecutionCtx,
			);

			expect(res.status).toBe(200);
			const json = await res.json();
			expect(json.data.embeds[0].description).toBe(
				"Invalid Discord interaction: missing options",
			);
		});

		it("returns error response when question is empty", async () => {
			const res = await app.fetch(
				postRequest({
					type: 2,
					token: "t",
					data: { options: [{ value: "   " }] },
				}),
				mockEnv,
				mockExecutionCtx,
			);

			expect(res.status).toBe(200);
			const json = await res.json();
			expect(json.data.embeds[0].description).toBe(
				"Invalid Discord interaction: question must be a non-empty string",
			);
		});

		it("returns error response when workflow creation fails", async () => {
			mockWorkflowCreate.mockRejectedValue(new Error("workflow error"));

			const res = await app.fetch(
				postRequest({
					type: 2,
					token: "t",
					data: { options: [{ value: "question" }] },
				}),
				mockEnv,
				mockExecutionCtx,
			);

			expect(res.status).toBe(200);
			const json = await res.json();
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
			const json = await res.json();
			expect(json.data.embeds[0].description).toBe("Invalid interaction type");
		});
	});
});
