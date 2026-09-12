import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { buildAnswerPrompt } from "../../src/llm/promptBuilder";
import type { LlmPrompt } from "../../src/llm/types";
import type {
	CandidateConfig,
	EvalCase,
	EvalSuite,
	PriceCatalog,
} from "./types";

const REQUIRED_CATEGORIES = new Set<EvalCase["category"]>([
	"numeric_alias",
	"similar_name",
	"ambiguous",
	"unknown",
	"conversation",
	"japanese_format",
	"long_context",
]);

export async function loadJsonFile<T>(path: string): Promise<T> {
	return JSON.parse(await readFile(path, "utf8")) as T;
}

export function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function buildPrompt(suite: EvalSuite, testCase: EvalCase): LlmPrompt {
	return buildAnswerPrompt({
		description: suite.description,
		knowledge: suite.knowledge,
		history: testCase.history,
		question: testCase.question,
	});
}

export function promptBytes(prompt: LlmPrompt): number {
	return Buffer.byteLength(JSON.stringify(prompt), "utf8");
}

export function suiteHash(suite: EvalSuite): string {
	return sha256(JSON.stringify(suite));
}

export function promptHashes(suite: EvalSuite): Record<string, string> {
	return Object.fromEntries(
		suite.cases.map((testCase) => [
			testCase.id,
			sha256(JSON.stringify(buildPrompt(suite, testCase))),
		]),
	);
}

function assertUnique(values: string[], label: string): void {
	if (new Set(values).size !== values.length) {
		throw new Error(`${label} must be unique`);
	}
}

function validateCandidate(candidate: CandidateConfig): void {
	if (
		!candidate.id ||
		!candidate.label ||
		!candidate.model ||
		(candidate.temperature !== 0 && candidate.temperature !== null) ||
		candidate.reasoningSetting !== "provider_default"
	) {
		throw new Error("every candidate requires id, label, and model");
	}
	if (candidate.summary && !candidate.summary.model) {
		throw new Error(`candidate ${candidate.id} has an invalid summary model`);
	}
}

export function validateSuite(suite: EvalSuite): void {
	if (suite.cases.length !== 12) {
		throw new Error("evaluation suite must contain exactly 12 cases");
	}
	if (suite.repetitions !== 3) {
		throw new Error("evaluation suite must use exactly 3 repetitions");
	}
	if (suite.maxOutputTokens !== 1024) {
		throw new Error("evaluation suite must cap answers at 1024 tokens");
	}
	if (suite.budgetUsd !== 5) {
		throw new Error("evaluation suite must use the approved 5 USD budget");
	}
	assertUnique(
		suite.candidates.map(({ id }) => id),
		"candidate ids",
	);
	assertUnique(
		suite.cases.map(({ id }) => id),
		"case ids",
	);
	for (const candidate of suite.candidates) validateCandidate(candidate);
	for (const category of REQUIRED_CATEGORIES) {
		if (!suite.cases.some((testCase) => testCase.category === category)) {
			throw new Error(`evaluation suite is missing category ${category}`);
		}
	}
	for (const testCase of suite.cases) {
		const bytes = promptBytes(buildPrompt(suite, testCase));
		if (bytes > suite.maxPromptBytes) {
			throw new Error(
				`case ${testCase.id} prompt is ${bytes} bytes; limit is ${suite.maxPromptBytes}`,
			);
		}
	}
}

export function validatePriceCoverage(
	suite: EvalSuite,
	catalog: PriceCatalog,
): void {
	const keys = new Set(
		catalog.entries.map(({ provider, model }) => `${provider}:${model}`),
	);
	for (const candidate of suite.candidates) {
		const required = [
			`${candidate.provider}:${candidate.model}`,
			...(candidate.summary
				? [`${candidate.summary.provider}:${candidate.summary.model}`]
				: []),
		];
		for (const key of required) {
			if (!keys.has(key)) throw new Error(`price catalog is missing ${key}`);
		}
	}
}
