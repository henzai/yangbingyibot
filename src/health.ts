import {
	createGitHubIssueClient,
	type HealthCheckReport,
} from "./clients/github";
import {
	createMetricsClient,
	type IMetricsClient,
	NoOpMetricsClient,
} from "./clients/metrics";
import type { Bindings } from "./types";
import { getErrorMessage } from "./utils/errors";
import type { Logger } from "./utils/logger";

type CheckName = "kv" | "gemini" | "google_sa";

export type CheckResult = {
	name: CheckName;
	ok: boolean;
	durationMs: number;
	error?: string;
};

export type HealthCheckResult = {
	checks: CheckResult[];
	allHealthy: boolean;
};

const GEMINI_MODELS_URL =
	"https://generativelanguage.googleapis.com/v1beta/models";
const ERROR_REPORTED_TTL_SECONDS = 60 * 60; // 1 hour

async function checkKV(kv: KVNamespace): Promise<CheckResult> {
	const start = Date.now();
	try {
		await kv.get("__health_check__");
		return { name: "kv", ok: true, durationMs: Date.now() - start };
	} catch (error) {
		return {
			name: "kv",
			ok: false,
			durationMs: Date.now() - start,
			error: getErrorMessage(error),
		};
	}
}

async function checkGemini(apiKey: string): Promise<CheckResult> {
	const start = Date.now();
	try {
		const res = await fetch(`${GEMINI_MODELS_URL}?key=${apiKey}`);
		if (res.ok) {
			return { name: "gemini", ok: true, durationMs: Date.now() - start };
		}
		return {
			name: "gemini",
			ok: false,
			durationMs: Date.now() - start,
			error: `HTTP ${res.status}`,
		};
	} catch (error) {
		return {
			name: "gemini",
			ok: false,
			durationMs: Date.now() - start,
			error: getErrorMessage(error),
		};
	}
}

function checkGoogleSA(saJson: string): CheckResult {
	const start = Date.now();
	try {
		const parsed = JSON.parse(saJson);
		if (!parsed.client_email || !parsed.private_key) {
			return {
				name: "google_sa",
				ok: false,
				durationMs: Date.now() - start,
				error: "Missing required fields: client_email or private_key",
			};
		}
		return { name: "google_sa", ok: true, durationMs: Date.now() - start };
	} catch (error) {
		return {
			name: "google_sa",
			ok: false,
			durationMs: Date.now() - start,
			error: getErrorMessage(error),
		};
	}
}

async function reportHealthCheckToGitHub(
	env: Bindings,
	failedChecks: CheckResult[],
	passedChecks: CheckResult[],
	log: Logger,
): Promise<void> {
	try {
		if (!env.GITHUB_TOKEN) {
			log.debug("GITHUB_TOKEN not set, skipping health check report");
			return;
		}

		const github = createGitHubIssueClient(env.GITHUB_TOKEN, log);
		const failedNames = failedChecks
			.map((c) => c.name)
			.sort()
			.join(",");
		const fingerprint = `health_check:${failedNames}`;
		const kvKey = `error_reported:${fingerprint}`;

		// Layer 1: KV deduplication
		const existing = await env.sushanshan_bot.get(kvKey);
		if (existing) {
			log.debug("Health check already reported (KV cache hit)", {
				fingerprint,
			});
			return;
		}

		// Layer 2: GitHub Issues search deduplication
		const isDup = await github.isDuplicate(fingerprint);
		if (isDup) {
			log.debug("Health check already reported (GitHub search hit)", {
				fingerprint,
			});
			await env.sushanshan_bot.put(kvKey, "1", {
				expirationTtl: ERROR_REPORTED_TTL_SECONDS,
			});
			return;
		}

		const report: HealthCheckReport = {
			failedChecks: failedChecks.map((c) => ({
				name: c.name,
				error: c.error ?? "Unknown error",
				durationMs: c.durationMs,
			})),
			passedChecks: passedChecks.map((c) => ({
				name: c.name,
				durationMs: c.durationMs,
			})),
			timestamp: new Date().toISOString(),
		};

		const created = await github.createHealthCheckIssue(report, fingerprint);
		if (created) {
			await env.sushanshan_bot.put(kvKey, "1", {
				expirationTtl: ERROR_REPORTED_TTL_SECONDS,
			});
			log.info("Health check reported to GitHub Issues", { fingerprint });
		}
	} catch (error) {
		log.warn("Failed to report health check to GitHub (non-fatal)", {
			error: getErrorMessage(error),
		});
	}
}

export async function runHealthCheck(
	env: Bindings,
	log: Logger,
): Promise<HealthCheckResult> {
	const metrics: IMetricsClient = env.METRICS
		? createMetricsClient(env.METRICS, log)
		: new NoOpMetricsClient();

	// Run all checks in parallel
	const results = await Promise.allSettled([
		checkKV(env.sushanshan_bot),
		checkGemini(env.GEMINI_API_KEY),
		Promise.resolve(checkGoogleSA(env.GOOGLE_SERVICE_ACCOUNT)),
	]);

	const checks: CheckResult[] = results.map((result) => {
		if (result.status === "fulfilled") {
			return result.value;
		}
		return {
			name: "kv" as CheckName,
			ok: false,
			durationMs: 0,
			error: getErrorMessage(result.reason),
		};
	});

	// Record metrics for each check
	for (const check of checks) {
		metrics.recordHealthCheck({
			checkName: check.name,
			success: check.ok,
			durationMs: check.durationMs,
		});
	}

	const allHealthy = checks.every((c) => c.ok);

	if (!allHealthy) {
		const failedChecks = checks.filter((c) => !c.ok);
		const passedChecks = checks.filter((c) => c.ok);
		log.warn("Health check failures detected", {
			failed: failedChecks.map((c) => c.name),
		});
		await reportHealthCheckToGitHub(env, failedChecks, passedChecks, log);
	} else {
		log.info("All health checks passed");
	}

	return { checks, allHealthy };
}
