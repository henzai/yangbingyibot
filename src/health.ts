import {
	createGitHubIssueClient,
	type HealthCheckReport,
} from "./clients/github";
import {
	createMetricsClient,
	type IMetricsClient,
	NoOpMetricsClient,
} from "./clients/metrics";
import { loadConfig } from "./config";
import type { Bindings } from "./contracts";
import { createLlmGateway } from "./llm/factory";
import type { LlmRoutingConfig, LlmSelection } from "./llm/providerCatalog";
import type { ILlmGateway } from "./llm/types";
import { createDeduplicationStore } from "./repositories/deduplicationStore";
import {
	ExternalServiceError,
	getErrorMessage,
	getExternalErrorLogContext,
} from "./utils/errors";
import type { Logger } from "./utils/logger";

type HealthStatus = "healthy" | "unhealthy" | "unverified";
type HealthPurpose = "answer" | "summary";

export type CheckResult = {
	name: string;
	ok: boolean;
	status: HealthStatus;
	durationMs: number;
	error?: string;
	errorKind?:
		| "authentication"
		| "timeout"
		| "transport"
		| "capability"
		| "probe_unavailable";
	provider?: string;
	model?: string;
	purposes?: HealthPurpose[];
	probeScope?: "model_metadata";
	generationSupport?: "supported" | "unverified";
	detail?: string;
};

export type HealthCheckResult = {
	checks: CheckResult[];
	allHealthy: boolean;
};

const ERROR_REPORTED_TTL_SECONDS = 60 * 60; // 1 hour
const LLM_PROBE_TIMEOUT_MS = 5_000;

type GatewayFactory = (selection: LlmSelection, log?: Logger) => ILlmGateway;

async function checkKV(kv: KVNamespace): Promise<CheckResult> {
	const start = Date.now();
	try {
		await kv.get("__health_check__");
		return {
			name: "kv",
			ok: true,
			status: "healthy",
			durationMs: Date.now() - start,
		};
	} catch (error) {
		return {
			name: "kv",
			ok: false,
			status: "unhealthy",
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
				status: "unhealthy",
				durationMs: Date.now() - start,
				error: "Missing required fields: client_email or private_key",
			};
		}
		return {
			name: "google_sa",
			ok: true,
			status: "healthy",
			durationMs: Date.now() - start,
		};
	} catch {
		return {
			name: "google_sa",
			ok: false,
			status: "unhealthy",
			durationMs: Date.now() - start,
			error: "Invalid service account JSON format",
		};
	}
}

function classifyProbeError(error: unknown): CheckResult["errorKind"] {
	if (!(error instanceof ExternalServiceError)) return "transport";
	if (error.kind === "timeout") return "timeout";
	if (error.status === 401 || error.status === 403) return "authentication";
	return error.kind === "transport" ? "transport" : "capability";
}

async function checkLlmTarget(
	selection: LlmSelection,
	purposes: HealthPurpose[],
	gateway: ILlmGateway,
): Promise<CheckResult> {
	const start = Date.now();
	const name = `llm:${selection.provider}:${selection.model}:${purposes.join("+")}`;
	if (!gateway.probe) {
		return {
			name,
			ok: false,
			status: "unverified",
			durationMs: Date.now() - start,
			error: "A safe non-generating health probe is not implemented",
			errorKind: "probe_unavailable",
			provider: selection.provider,
			model: selection.model,
			purposes,
		};
	}
	try {
		const result = await gateway.probe({
			model: selection.model,
			timeoutMs: LLM_PROBE_TIMEOUT_MS,
		});
		const status: HealthStatus =
			result.status === "available"
				? "healthy"
				: result.status === "unavailable"
					? "unhealthy"
					: "unverified";
		return {
			name,
			ok: status === "healthy",
			status,
			durationMs: Date.now() - start,
			...(status !== "healthy" && result.detail
				? { error: result.detail }
				: {}),
			...(status === "unhealthy" ? { errorKind: "capability" as const } : {}),
			...(status === "unverified"
				? { errorKind: "probe_unavailable" as const }
				: {}),
			provider: selection.provider,
			model: selection.model,
			purposes,
			probeScope: result.scope,
			generationSupport: result.generationSupport,
			detail: status === "healthy" ? result.detail : undefined,
		};
	} catch (error) {
		return {
			name,
			ok: false,
			status: "unhealthy",
			durationMs: Date.now() - start,
			error: getErrorMessage(error),
			errorKind: classifyProbeError(error),
			provider: selection.provider,
			model: selection.model,
			purposes,
			probeScope: "model_metadata",
		};
	}
}

/** Probe each selected provider/model once, combining shared answer/summary use. */
function checkConfiguredLlms(
	config: LlmRoutingConfig,
	log: Logger,
	gatewayFactory: GatewayFactory,
): Array<Promise<CheckResult>> {
	const targets = new Map<
		string,
		{ selection: LlmSelection; purposes: HealthPurpose[] }
	>();
	for (const [selection, purpose] of [
		[config.answer, "answer"],
		...(config.summary ? [[config.summary, "summary"]] : []),
	] as Array<[LlmSelection, HealthPurpose]>) {
		const key = JSON.stringify([selection.provider, selection.model]);
		const target = targets.get(key);
		if (target) target.purposes.push(purpose);
		else targets.set(key, { selection, purposes: [purpose] });
	}
	const gateways = new Map<string, ILlmGateway>();
	return [...targets.values()].map(async ({ selection, purposes }) => {
		try {
			let gateway = gateways.get(selection.provider);
			if (!gateway) {
				gateway = gatewayFactory(selection, log);
				gateways.set(selection.provider, gateway);
			}
			return await checkLlmTarget(selection, purposes, gateway);
		} catch (error) {
			return {
				name: `llm:${selection.provider}:${selection.model}:${purposes.join("+")}`,
				ok: false,
				status: "unverified" as const,
				durationMs: 0,
				error: getErrorMessage(error),
				errorKind: "probe_unavailable" as const,
				provider: selection.provider,
				model: selection.model,
				purposes,
			};
		}
	});
}

async function reportHealthCheckToGitHub(
	env: Bindings,
	failedChecks: CheckResult[],
	passedChecks: CheckResult[],
	log: Logger,
): Promise<void> {
	try {
		const config = loadConfig(env);
		if (!config.githubToken) {
			log.debug("GITHUB_TOKEN not set, skipping health check report");
			return;
		}

		const github = createGitHubIssueClient(
			config.githubToken,
			log,
			config.githubRepository,
		);
		const deduplicationStore = createDeduplicationStore(env.sushanshan_bot);
		const infrastructureFailures = failedChecks.filter(
			(check) => !check.provider,
		);
		const incidentGroups = [
			...(infrastructureFailures.length > 0 ? [infrastructureFailures] : []),
			...failedChecks.filter((check) => check.provider).map((check) => [check]),
		];
		for (const incidentChecks of incidentGroups) {
			const identity = incidentChecks
				.map((check) =>
					check.provider
						? [
								check.status,
								check.provider,
								check.model,
								check.purposes?.join("+"),
								check.errorKind,
							]
								.map((part) => encodeURIComponent(part ?? ""))
								.join(":")
						: `${check.status}:${encodeURIComponent(check.name)}:${check.errorKind ?? ""}`,
				)
				.sort()
				.join(",");
			const fingerprint = `health_check:v2:${identity}`;
			const kvKey = `error_reported:${fingerprint}`;

			try {
				if (await deduplicationStore.isMarked(kvKey)) {
					log.debug("Health check already reported (KV cache hit)", {
						fingerprint,
					});
					continue;
				}
				if (await github.isDuplicate(fingerprint)) {
					log.debug("Health check already reported (GitHub search hit)", {
						fingerprint,
					});
					await deduplicationStore.mark(kvKey, ERROR_REPORTED_TTL_SECONDS);
					continue;
				}

				const report: HealthCheckReport = {
					failedChecks: incidentChecks.map((check) => ({
						name: check.name,
						error: check.error ?? "Unknown error",
						durationMs: check.durationMs,
						status: check.status === "unverified" ? "unverified" : "unhealthy",
						provider: check.provider,
						model: check.model,
						purposes: check.purposes,
						errorKind: check.errorKind,
						probeScope: check.probeScope,
						generationSupport: check.generationSupport,
						detail: check.detail,
					})),
					passedChecks: passedChecks.map((check) => ({
						name: check.name,
						durationMs: check.durationMs,
						status: "healthy" as const,
						provider: check.provider,
						model: check.model,
						purposes: check.purposes,
						probeScope: check.probeScope,
						generationSupport: check.generationSupport,
						detail: check.detail,
					})),
					timestamp: new Date().toISOString(),
				};

				await github.createHealthCheckIssue(report, fingerprint);
				await deduplicationStore.mark(kvKey, ERROR_REPORTED_TTL_SECONDS);
				log.info("Health check reported to GitHub Issues", { fingerprint });
			} catch (error) {
				log.warn("Failed to report health check incident (non-fatal)", {
					fingerprint,
					...getExternalErrorLogContext(error),
				});
			}
		}
	} catch (error) {
		log.warn("Failed to report health check to GitHub (non-fatal)", {
			...getExternalErrorLogContext(error),
		});
	}
}

export async function runHealthCheck(
	env: Bindings,
	log: Logger,
	gatewayFactory: GatewayFactory = createLlmGateway,
): Promise<HealthCheckResult> {
	const config = loadConfig(env);
	const metrics: IMetricsClient = env.METRICS
		? createMetricsClient(env.METRICS, log)
		: new NoOpMetricsClient();

	// Run all checks in parallel
	const checks = await Promise.all([
		checkKV(env.sushanshan_bot),
		...checkConfiguredLlms(config.llm, log, gatewayFactory),
		Promise.resolve(checkGoogleSA(config.googleServiceAccount)),
	]);

	// Record metrics for each check
	for (const check of checks) {
		metrics.recordHealthCheck({
			checkName: check.name,
			success: check.ok,
			durationMs: check.durationMs,
			status: check.status,
			provider: check.provider,
			model: check.model,
			purposes: check.purposes,
			errorKind: check.errorKind,
			probeScope: check.probeScope,
			generationSupport: check.generationSupport,
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
