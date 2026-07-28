import type { ParsedDiscordAskCommand } from "../contracts";

const APPLICATION_COMMAND_INTERACTION_TYPE = 2;
const STRING_COMMAND_OPTION_TYPE = 3;
const ASK_COMMAND_NAME = "ask";
const QUESTION_OPTION_NAME = "question";
const MAX_QUESTION_LENGTH = 6000;
const DM_GUILD_NAMESPACE = "dm";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getNonEmptyString(
	record: UnknownRecord,
	key: string,
	errorMessage: string,
): string {
	const value = record[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(errorMessage);
	}
	return value.trim();
}

function getUserId(body: UnknownRecord, guildId: string | undefined): string {
	if (guildId !== undefined) {
		const member = body.member;
		if (!isRecord(member) || !isRecord(member.user)) {
			throw new Error("Invalid Discord interaction: missing or invalid user");
		}
		return getNonEmptyString(
			member.user,
			"id",
			"Invalid Discord interaction: missing or invalid user",
		);
	}

	const user = body.user;
	if (!isRecord(user)) {
		throw new Error("Invalid Discord interaction: missing or invalid user");
	}
	return getNonEmptyString(
		user,
		"id",
		"Invalid Discord interaction: missing or invalid user",
	);
}

function bytesToHex(bytes: ArrayBuffer): string {
	return Array.from(new Uint8Array(bytes), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

export function getInteractionType(value: unknown): number | undefined {
	if (!isRecord(value) || typeof value.type !== "number") {
		return undefined;
	}
	return value.type;
}

export async function createConversationKey({
	guildId,
	channelId,
	userId,
}: {
	guildId?: string;
	channelId: string;
	userId: string;
}): Promise<string> {
	const material = `${guildId ?? DM_GUILD_NAMESPACE}:${channelId}:${userId}`;
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(material),
	);
	return bytesToHex(digest);
}

export async function parseDiscordAskCommand(
	value: unknown,
): Promise<ParsedDiscordAskCommand> {
	if (!isRecord(value) || value.type !== APPLICATION_COMMAND_INTERACTION_TYPE) {
		throw new Error("Invalid Discord interaction: invalid command type");
	}

	const token = getNonEmptyString(
		value,
		"token",
		"Invalid Discord interaction: missing or invalid token",
	);
	const channelId = getNonEmptyString(
		value,
		"channel_id",
		"Invalid Discord interaction: missing or invalid channel",
	);

	const rawGuildId = value.guild_id;
	if (
		rawGuildId !== undefined &&
		(typeof rawGuildId !== "string" || rawGuildId.trim().length === 0)
	) {
		throw new Error("Invalid Discord interaction: invalid guild");
	}
	const guildId =
		typeof rawGuildId === "string" ? rawGuildId.trim() : undefined;
	const userId = getUserId(value, guildId);

	const data = value.data;
	if (!isRecord(data) || data.name !== ASK_COMMAND_NAME) {
		throw new Error("Invalid Discord interaction: invalid command");
	}
	if (!Array.isArray(data.options)) {
		throw new Error(
			"Invalid Discord interaction: missing or invalid question option",
		);
	}

	const questionOption = data.options.find(
		(option) =>
			isRecord(option) &&
			option.name === QUESTION_OPTION_NAME &&
			option.type === STRING_COMMAND_OPTION_TYPE,
	);
	if (!isRecord(questionOption) || typeof questionOption.value !== "string") {
		throw new Error(
			"Invalid Discord interaction: missing or invalid question option",
		);
	}

	const question = questionOption.value.trim();
	if (question.length === 0 || question.length > MAX_QUESTION_LENGTH) {
		throw new Error(
			`Invalid Discord interaction: question must be between 1 and ${MAX_QUESTION_LENGTH} characters`,
		);
	}

	return {
		token,
		question,
		conversationKey: await createConversationKey({
			guildId,
			channelId,
			userId,
		}),
	};
}
