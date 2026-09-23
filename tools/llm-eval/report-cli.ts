import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeAutomaticEvaluation, summarizeEvaluation } from "./scoring";
import { loadEvalSuite, loadJsonFile, suiteHash } from "./suite";
import type { EvaluationArtifact, ManualJudgmentArtifact } from "./types";

const toolDirectory = dirname(fileURLToPath(import.meta.url));
const suitePathsByVersion = {
	"llm-switch-v1": resolve(toolDirectory, "fixtures/suite-v1.json"),
	"llm-switch-v2-luna-max": resolve(
		toolDirectory,
		"fixtures/suite-v2-luna-max.json",
	),
} as const;

function parseRunDirectory(args: string[]): string {
	const index = args.indexOf("--run");
	if (index === -1 || !args[index + 1]) {
		throw new Error("usage: npm run eval:llm:report -- --run .llm-eval/<run>");
	}
	return resolve(args[index + 1]);
}

function percent(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

async function writeAutomaticReport(
	runDirectory: string,
	artifact: EvaluationArtifact,
): Promise<void> {
	const summary = summarizeAutomaticEvaluation(artifact.results);
	const lines = [
		"# LLM automatic evaluation summary",
		"",
		`- Suite: \`${artifact.suiteVersion}\` (\`${artifact.suiteHash}\`)`,
		`- Commit: \`${artifact.gitCommit}\``,
		`- Pricing snapshot: \`${artifact.pricingVersion}\` (${artifact.pricingEffectiveDate})`,
		`- Trials: ${artifact.results.length} (${artifact.repetitions} repetitions per case/model)`,
		"- Scoring: deterministic required terms, forbidden terms, deferral signals, Japanese/timeline format, failures, latency, and cost.",
		"- Limitation: these rates are automatic ceilings. They do not verify that every free-form claim is supported and do not establish a zero hallucination rate.",
		"- Decision: automatic-only scoring does not assign a quality-gate pass or model recommendation.",
		"",
		"| Candidate | Runs | Required terms | Forbidden terms absent | Grounding ceiling | Deferral ceiling | Format ceiling | Failure | First text med/p95 | Total med/p95 | Median cost |",
		"| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
		...summary.candidates.map((candidate) =>
			[
				candidate.candidateId,
				candidate.runCount,
				percent(candidate.requiredTermsRate),
				percent(candidate.forbiddenTermsRate),
				percent(candidate.groundingCeiling),
				percent(candidate.deferralCeiling),
				percent(candidate.formatCeiling),
				percent(candidate.failureRate),
				`${candidate.medianFirstTextMs.toFixed(0)} / ${candidate.p95FirstTextMs.toFixed(0)} ms`,
				`${candidate.medianTotalCompletionMs.toFixed(0)} / ${candidate.p95TotalCompletionMs.toFixed(0)} ms`,
				`$${candidate.medianCostUsd.toFixed(6)}`,
			]
				.join(" | ")
				.replace(/^/, "| ")
				.concat(" |"),
		),
		"",
	];
	await writeFile(
		`${runDirectory}/summary.json`,
		`${JSON.stringify(summary, null, 2)}\n`,
		{ mode: 0o600 },
	);
	await writeFile(`${runDirectory}/summary.md`, lines.join("\n"), {
		mode: 0o600,
	});
}

async function main(): Promise<void> {
	const runDirectory = parseRunDirectory(process.argv.slice(2));
	const artifact = await loadJsonFile<EvaluationArtifact>(
		`${runDirectory}/evaluation.json`,
	);
	const suitePath =
		suitePathsByVersion[
			artifact.suiteVersion as keyof typeof suitePathsByVersion
		];
	if (!suitePath) {
		throw new Error(`unknown evaluation suite: ${artifact.suiteVersion}`);
	}
	const suite = await loadEvalSuite(suitePath);
	if (artifact.abortedReason) throw new Error(artifact.abortedReason);
	const scoringMode = suite.scoringMode ?? "manual";
	if (artifact.scoringMode !== scoringMode) {
		throw new Error(
			"scoring mode mismatch; do not grade changed evaluation data",
		);
	}
	const expectedRuns =
		suite.candidates.length * suite.cases.length * suite.repetitions;
	if (artifact.results.length !== expectedRuns) {
		throw new Error(
			`evaluation is incomplete: ${artifact.results.length}/${expectedRuns} runs`,
		);
	}
	if (artifact.suiteHash !== suiteHash(suite)) {
		throw new Error(
			"suite hash mismatch; do not grade changed evaluation data",
		);
	}
	if (scoringMode === "automatic_only") {
		await writeAutomaticReport(runDirectory, artifact);
		console.log(`sanitized automatic summary: ${runDirectory}/summary.md`);
		return;
	}
	const judgments = await loadJsonFile<ManualJudgmentArtifact>(
		`${runDirectory}/judgments.json`,
	);
	if (judgments.suiteHash !== artifact.suiteHash) {
		throw new Error(
			"suite hash mismatch; do not grade changed evaluation data",
		);
	}
	const summary = summarizeEvaluation(
		artifact.results,
		judgments.judgments,
		suite.candidates[0].id,
	);
	const usageEstimatedRuns = artifact.results.filter(
		({ cost }) => (cost?.missingUsageEstimateUsd ?? 0) > 0,
	).length;
	const retryEstimatedRuns = artifact.results.filter(
		({ cost }) => (cost?.retryReserveUsd ?? 0) > 0,
	).length;
	const lines = [
		"# LLM evaluation summary",
		"",
		`- Suite: \`${artifact.suiteVersion}\` (\`${artifact.suiteHash}\`)`,
		`- Seed: \`${artifact.seed}\``,
		`- Commit: \`${artifact.gitCommit}\``,
		`- Pricing: \`${artifact.pricingVersion}\`, effective ${artifact.pricingEffectiveDate}`,
		`- SDKs: Gemini \`${artifact.providerSdkVersions.gemini}\`, OpenAI \`${artifact.providerSdkVersions.openai}\``,
		`- Execution: \`${artifact.executionOrder}\`; cache: \`${artifact.cachePolicy}\``,
		`- Trials: ${artifact.results.length} (${artifact.repetitions} repetitions per case/model)`,
		`- Small-sample warning: per-case p95 is based on only ${artifact.repetitions} observations.`,
		`- Cost qualification: ${usageEstimatedRuns}/${artifact.results.length} runs include conservative estimates for omitted usage counters; ${retryEstimatedRuns}/${artifact.results.length} include retry reserves.`,
		"",
		"| Candidate | Runs | Mix-up | Unsupported person/bio | Grounded | Deferral | Format | Failure | First text med/p95 | Answer med/p95 | Total med/p95 | Median cost | Gate |",
		"| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
		...summary.candidates.map((candidate) =>
			[
				candidate.candidateId,
				candidate.runCount,
				percent(candidate.personMixupRate),
				candidate.unsupportedPersonOrBiographyCount,
				percent(candidate.groundedAnswerRate),
				percent(candidate.appropriateDeferralRate),
				percent(candidate.formatPassRate),
				percent(candidate.failureRate),
				`${candidate.medianFirstTextMs.toFixed(0)} / ${candidate.p95FirstTextMs.toFixed(0)} ms`,
				`${candidate.medianAnswerCompletionMs.toFixed(0)} / ${candidate.p95AnswerCompletionMs.toFixed(0)} ms`,
				`${candidate.medianTotalCompletionMs.toFixed(0)} / ${candidate.p95TotalCompletionMs.toFixed(0)} ms`,
				`$${candidate.medianCostUsd.toFixed(6)}`,
				candidate.passesQualityGate
					? "PASS"
					: `FAIL (${candidate.failedGates.join(", ")})`,
			]
				.join(" | ")
				.replace(/^/, "| ")
				.concat(" |"),
		),
		"",
		"## Per-case metrics",
		"",
		"| Candidate | Case | Runs | Mix-up | Unsupported person/bio | Grounded | Deferral | Format | Failure | First text med/p95 | Answer med/p95 | Total med/p95 | Median cost |",
		"| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
		...summary.candidates.flatMap((candidate) =>
			candidate.cases.map((caseSummary) =>
				[
					candidate.candidateId,
					caseSummary.caseId,
					caseSummary.runCount,
					percent(caseSummary.personMixupRate),
					caseSummary.unsupportedPersonOrBiographyCount,
					percent(caseSummary.groundedAnswerRate),
					percent(caseSummary.appropriateDeferralRate),
					percent(caseSummary.formatPassRate),
					percent(caseSummary.failureRate),
					`${caseSummary.medianFirstTextMs.toFixed(0)} / ${caseSummary.p95FirstTextMs.toFixed(0)} ms`,
					`${caseSummary.medianAnswerCompletionMs.toFixed(0)} / ${caseSummary.p95AnswerCompletionMs.toFixed(0)} ms`,
					`${caseSummary.medianTotalCompletionMs.toFixed(0)} / ${caseSummary.p95TotalCompletionMs.toFixed(0)} ms`,
					`$${caseSummary.medianCostUsd.toFixed(6)}`,
				]
					.join(" | ")
					.replace(/^/, "| ")
					.concat(" |"),
			),
		),
		"",
		`Recommendation: **${summary.recommendedCandidateId}**`,
		"",
		summary.recommendationReason,
		"",
	];
	await writeFile(
		`${runDirectory}/summary.json`,
		`${JSON.stringify(summary, null, 2)}\n`,
		{ mode: 0o600 },
	);
	await writeFile(`${runDirectory}/summary.md`, lines.join("\n"), {
		mode: 0o600,
	});
	console.log(`sanitized summary: ${runDirectory}/summary.md`);
}

main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : "unknown failure";
	console.error(`LLM evaluation report stopped: ${message}`);
	process.exitCode = 1;
});
