import { describe, expect, it } from "vitest";
import {
	createConversationKey,
	getInteractionType,
	parseDiscordAskCommand,
} from "./interaction";

function guildInteraction(question = "  質問です  ") {
	return {
		type: 2,
		token: "interaction-token",
		guild_id: "guild-1",
		channel_id: "channel-1",
		member: {
			user: {
				id: "user-1",
			},
		},
		data: {
			name: "ask",
			options: [
				{ name: "other", type: 3, value: "ignored" },
				{ name: "question", type: 3, value: question },
			],
		},
	};
}

function dmInteraction(question = "DM question") {
	return {
		type: 2,
		token: "dm-token",
		channel_id: "dm-channel",
		user: {
			id: "dm-user",
		},
		data: {
			name: "ask",
			options: [{ name: "question", type: 3, value: question }],
		},
	};
}

describe("Discord interaction parsing", () => {
	it("reads the interaction type only from an object with a numeric type", () => {
		expect(getInteractionType({ type: 1 })).toBe(1);
		expect(getInteractionType({ type: "1" })).toBeUndefined();
		expect(getInteractionType(null)).toBeUndefined();
	});

	it("parses a guild command by option name and hashes its conversation IDs", async () => {
		const parsed = await parseDiscordAskCommand(guildInteraction());

		expect(parsed).toEqual({
			token: "interaction-token",
			question: "質問です",
			conversationKey: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
		expect(JSON.stringify(parsed)).not.toContain("user-1");
		expect(JSON.stringify(parsed)).not.toContain("channel-1");
		expect(JSON.stringify(parsed)).not.toContain("guild-1");
	});

	it("parses a DM command using the top-level user", async () => {
		const parsed = await parseDiscordAskCommand(dmInteraction());

		expect(parsed.token).toBe("dm-token");
		expect(parsed.question).toBe("DM question");
		expect(parsed.conversationKey).toMatch(/^[0-9a-f]{64}$/);
	});

	it.each([
		["command name", { ...guildInteraction(), data: { name: "other" } }],
		["token", { ...guildInteraction(), token: " " }],
		["channel", { ...guildInteraction(), channel_id: undefined }],
		["guild user", { ...guildInteraction(), member: undefined }],
		["DM user", { ...dmInteraction(), user: undefined }],
		[
			"option name",
			{
				...guildInteraction(),
				data: {
					name: "ask",
					options: [{ name: "other", type: 3, value: "question" }],
				},
			},
		],
		[
			"option type",
			{
				...guildInteraction(),
				data: {
					name: "ask",
					options: [{ name: "question", type: 4, value: "question" }],
				},
			},
		],
	])("rejects a missing or invalid %s", async (_label, interaction) => {
		await expect(parseDiscordAskCommand(interaction)).rejects.toThrow(
			"Invalid Discord interaction",
		);
	});

	it("accepts a 6000-character trimmed question", async () => {
		const parsed = await parseDiscordAskCommand(
			guildInteraction("x".repeat(6000)),
		);

		expect(parsed.question).toHaveLength(6000);
	});

	it.each(["   ", "x".repeat(6001)])(
		"rejects an empty or oversized question",
		async (question) => {
			await expect(
				parseDiscordAskCommand(guildInteraction(question)),
			).rejects.toThrow(
				"Invalid Discord interaction: question must be between 1 and 6000 characters",
			);
		},
	);
});

describe("conversation keys", () => {
	it("is stable for the same guild, channel, and user", async () => {
		const input = {
			guildId: "guild-1",
			channelId: "channel-1",
			userId: "user-1",
		};

		expect(await createConversationKey(input)).toBe(
			await createConversationKey(input),
		);
	});

	it("changes when the user or channel changes", async () => {
		const baseline = await createConversationKey({
			guildId: "guild-1",
			channelId: "channel-1",
			userId: "user-1",
		});
		const otherUser = await createConversationKey({
			guildId: "guild-1",
			channelId: "channel-1",
			userId: "user-2",
		});
		const otherChannel = await createConversationKey({
			guildId: "guild-1",
			channelId: "channel-2",
			userId: "user-1",
		});

		expect(otherUser).not.toBe(baseline);
		expect(otherChannel).not.toBe(baseline);
	});

	it("uses a distinct namespace for DM conversations", async () => {
		const dm = await createConversationKey({
			channelId: "channel-1",
			userId: "user-1",
		});
		const guild = await createConversationKey({
			guildId: "guild-1",
			channelId: "channel-1",
			userId: "user-1",
		});

		expect(dm).not.toBe(guild);
		expect(dm).toMatch(/^[0-9a-f]{64}$/);
	});
});
