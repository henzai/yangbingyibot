import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { config as loadDotenv } from "dotenv";
import { createLlmGateway } from "../../src/llm/factory";
import { assertFreshPricing, estimateSuiteUpperBound } from "./pricing";
import { runEvaluation } from "./runner";
import {
	loadJsonFile,
	suiteHash,
	validatePriceCoverage,
	validateSuite,
} from "./suite";
import type {
	EvalProvider,
	EvalSuite,
	EvaluationArtifact,
	ManualJudgmentArtifact,
	PriceCatalog,
} from "./types";

const execFileAsync = promisify(execFile);
const toolDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(toolDirectory, "../..");
const suitePath = resolve(toolDirectory, "fixtures/suite-v1.json");
const pricingPath = resolve(toolDirectory, "fixtures/pricing.json");

function parseExecuteFlag(args: string[]): boolean {
	const allowed = new Set(["--execute"]);
	for (const argument of args) {
		if (!allowed.has(argument))
			throw new Error(`unknown argument: ${argument}`);
	}
	return args.includes("--execute");
}

function printPlan(
	suite: EvalSuite,
	prices: PriceCatalog,
	upperBound: number,
): void {
	console.log("LLM evaluation plan (no prompts or answers are printed)");
	console.log(`suite: ${suite.version} (${suiteHash(suite)})`);
	console.log(`cases: ${suite.cases.length}`);
	console.log(`repetitions: ${suite.repetitions}`);
	console.log(
		`planned answer calls: ${suite.candidates.length * suite.cases.length * suite.repetitions}`,
	);
	console.log(`max output tokens: ${suite.maxOutputTokens}`);
	console.log(`price effective date: ${prices.effectiveDate}`);
	console.log(`approved budget: ${suite.budgetUsd.toFixed(2)} USD`);
	console.log(`worst-case estimate: ${upperBound.toFixed(4)} USD`);
	for (const candidate of suite.candidates) {
		console.log(
			`candidate: ${candidate.id} (${candidate.provider}:${candidate.model}, summary ${candidate.summary ? `${candidate.summary.provider}:${candidate.summary.model}` : "disabled"})`,
		);
	}
}

function judgmentTemplate(
	artifact: EvaluationArtifact,
): ManualJudgmentArtifact {
	return {
		schemaVersion: 1,
		suiteHash: artifact.suiteHash,
		judgments: artifact.results
			.filter(({ success }) => success)
			.map(({ runId }) => ({
				runId,
				identityCorrect: null,
				unsupportedPersonOrBiography: null,
				supportedFacts: null,
				behaviorCorrect: null,
				formatCorrect: null,
				notes: "",
			})),
	};
}

function blindedReview(artifact: EvaluationArtifact): object {
	return {
		schemaVersion: 1,
		suiteHash: artifact.suiteHash,
		items: artifact.results.map((result) => ({
			runId: result.runId,
			blindedCandidateId: result.blindedCandidateId,
			caseId: result.caseId,
			category: result.category,
			repetition: result.repetition,
			success: result.success,
			response: result.response,
			automaticChecks: result.automaticChecks,
		})),
	};
}

async function main(): Promise<void> {
	const execute = parseExecuteFlag(process.argv.slice(2));
	const suite = await loadJsonFile<EvalSuite>(suitePath);
	const prices = await loadJsonFile<PriceCatalog>(pricingPath);
	validateSuite(suite);
	validatePriceCoverage(suite, prices);
	assertFreshPricing(prices);
	const upperBound = estimateSuiteUpperBound(suite, prices);
	printPlan(suite, prices, upperBound);
	if (upperBound > suite.budgetUsd) {
		throw new Error("worst-case estimate exceeds the approved budget");
	}
	if (!execute) {
		console.log("offline plan only; pass --execute to make real API calls");
		return;
	}

	loadDotenv({ path: `${repositoryRoot}/.env.local`, quiet: true });
	const apiKeys = {
		gemini: process.env.GEMINI_API_KEY ?? "",
		openai: process.env.OPENAI_API_KEY ?? "",
	} satisfies Record<EvalProvider, string>;
	const { stdout: commitOutput } = await execFileAsync(
		"git",
		["rev-parse", "HEAD"],
		{ cwd: repositoryRoot },
	);
	const geminiPackage = await loadJsonFile<{ version: string }>(
		resolve(repositoryRoot, "node_modules/@google/genai/package.json"),
	);
	const openaiPackage = await loadJsonFile<{ version: string }>(
		resolve(repositoryRoot, "node_modules/openai/package.json"),
	);
	const artifact = await runEvaluation({
		suite,
		prices,
		apiKeys,
		gitCommit: commitOutput.trim(),
		providerSdkVersions: {
			gemini: geminiPackage.version,
			openai: openaiPackage.version,
		},
		gatewayFactory: (provider, apiKey) =>
			createLlmGateway({ provider, model: "evaluation", apiKey }),
		onProgress: (message) => console.log(`running: ${message}`),
	});
	const runDirectory = `${repositoryRoot}/.llm-eval/${artifact.createdAt.replaceAll(":", "-")}`;
	await mkdir(runDirectory, { recursive: true, mode: 0o700 });
	await writeFile(
		`${runDirectory}/evaluation.json`,
		`${JSON.stringify(artifact, null, 2)}\n`,
		{ mode: 0o600 },
	);
	await writeFile(
		`${runDirectory}/judgments.json`,
		`${JSON.stringify(judgmentTemplate(artifact), null, 2)}\n`,
		{ mode: 0o600 },
	);
	await writeFile(
		`${runDirectory}/review.json`,
		`${JSON.stringify(blindedReview(artifact), null, 2)}\n`,
		{ mode: 0o600 },
	);
	console.log(`local evaluation artifact: ${runDirectory}/evaluation.json`);
	console.log(`blinded answers: ${runDirectory}/review.json`);
	console.log(`blinded judgment template: ${runDirectory}/judgments.json`);
	if (artifact.abortedReason) {
		throw new Error(artifact.abortedReason);
	}
}

main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : "unknown failure";
	console.error(`LLM evaluation stopped: ${message}`);
	process.exitCode = 1;
});
