import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeEvaluation } from "./scoring";
import { loadJsonFile, suiteHash } from "./suite";
import type {
	EvalSuite,
	EvaluationArtifact,
	ManualJudgmentArtifact,
} from "./types";

const toolDirectory = dirname(fileURLToPath(import.meta.url));
const suitePath = resolve(toolDirectory, "fixtures/suite-v1.json");

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

async function main(): Promise<void> {
	const runDirectory = parseRunDirectory(process.argv.slice(2));
	const artifact = await loadJsonFile<EvaluationArtifact>(
		`${runDirectory}/evaluation.json`,
	);
	const judgments = await loadJsonFile<ManualJudgmentArtifact>(
		`${runDirectory}/judgments.json`,
	);
	const suite = await loadJsonFile<EvalSuite>(suitePath);
	if (artifact.abortedReason) throw new Error(artifact.abortedReason);
	const expectedRuns =
		suite.candidates.length * suite.cases.length * suite.repetitions;
	if (artifact.results.length !== expectedRuns) {
		throw new Error(
			`evaluation is incomplete: ${artifact.results.length}/${expectedRuns} runs`,
		);
	}
	if (
		artifact.suiteHash !== suiteHash(suite) ||
		judgments.suiteHash !== artifact.suiteHash
	) {
		throw new Error(
			"suite hash mismatch; do not grade changed evaluation data",
		);
	}
	const summary = summarizeEvaluation(
		artifact.results,
		judgments.judgments,
		suite.candidates[0].id,
	);
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
