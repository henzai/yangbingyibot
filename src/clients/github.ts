import { DEFAULT_RUNTIME_CONFIG, type GitHubRepositoryConfig } from "../config";
import {
	externalServiceErrorFromResponse,
	normalizeExternalServiceError,
} from "../utils/errors";
import { logger as defaultLogger, type Logger } from "../utils/logger";
import { withRetry } from "../utils/retry";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_RETRY_CONFIG = {
	maxAttempts: 3,
	initialDelayMs: 500,
	maxDelayMs: 5000,
	backoffMultiplier: 2,
};

export interface ErrorReport {
	errorMessage: string;
	requestId: string;
	workflowId: string;
	step?: string;
	durationMs: number;
	stepCount: number;
	timestamp: string;
}

export interface HealthCheckReport {
	failedChecks: {
		name: string;
		error: string;
		durationMs: number;
	}[];
	passedChecks: {
		name: string;
		durationMs: number;
	}[];
	timestamp: string;
}

export class GitHubIssueClient {
	private token: string;
	private log: Logger;
	private repository: GitHubRepositoryConfig;

	constructor(
		token: string,
		log?: Logger,
		repository: GitHubRepositoryConfig = DEFAULT_RUNTIME_CONFIG.githubRepository,
	) {
		this.token = token;
		this.log = log ?? defaultLogger;
		this.repository = repository;
	}

	private async request(
		operation: string,
		url: string,
		init: RequestInit,
		retry: boolean,
	): Promise<Response> {
		const execute = async () => {
			try {
				const response = await fetch(url, init);
				if (!response.ok) {
					throw externalServiceErrorFromResponse(
						"github",
						operation,
						response,
						"GitHubへの障害報告に失敗しました。",
					);
				}
				return response;
			} catch (error) {
				throw normalizeExternalServiceError(error, {
					service: "github",
					operation,
					userMessage: "GitHubへの障害報告に失敗しました。",
				});
			}
		};

		return retry
			? withRetry(execute, GITHUB_RETRY_CONFIG, undefined, this.log)
			: execute();
	}

	private headers(contentType = false): Record<string, string> {
		return {
			Authorization: `Bearer ${this.token}`,
			Accept: "application/vnd.github+json",
			"User-Agent": "yangbingyibot-error-reporter",
			...(contentType ? { "Content-Type": "application/json" } : {}),
		};
	}

	/**
	 * Generate a fingerprint from an error message by removing dynamic elements.
	 * This allows grouping similar errors together for deduplication.
	 */
	generateFingerprint(errorMessage: string): string {
		return errorMessage
			.replace(
				/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
				"<UUID>",
			)
			.replace(/\b[0-9a-f]{8,}\b/gi, "<HEX>")
			.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[.\dZ]*/g, "<TIMESTAMP>")
			.replace(/\d+/g, "<N>");
	}

	/**
	 * Check if a GitHub Issue with the same fingerprint already exists (open).
	 * Read-only requests use the shared retry policy.
	 */
	async isDuplicate(fingerprint: string): Promise<boolean> {
		try {
			const query = encodeURIComponent(
				`repo:${this.repository.fullName} is:issue is:open label:auto-reported "${fingerprint}"`,
			);
			const res = await this.request(
				"search issues",
				`${GITHUB_API_BASE}/search/issues?q=${query}&per_page=1`,
				{
					headers: this.headers(),
				},
				true,
			);

			const data = (await res.json()) as { total_count: number };
			if (typeof data.total_count !== "number") {
				throw new Error("Invalid GitHub search response");
			}
			return data.total_count > 0;
		} catch (error) {
			throw normalizeExternalServiceError(error, {
				service: "github",
				operation: "parse issue search response",
				retryable: false,
				userMessage: "GitHubへの障害報告に失敗しました。",
			});
		}
	}

	/**
	 * Create a GitHub Issue for a health check failure.
	 * POST is attempted once because retrying an ambiguous network failure could
	 * create duplicate issues. Callers keep this operation non-fatal.
	 */
	async createHealthCheckIssue(
		report: HealthCheckReport,
		fingerprint: string,
	): Promise<void> {
		const failedNames = report.failedChecks.map((c) => c.name).join(", ");
		const title = `[Health Check] ${failedNames} 異常検知`;

		const allChecks = [
			...report.failedChecks.map((c) => ({
				name: c.name,
				status: "❌ 異常",
				durationMs: c.durationMs,
				detail: c.error,
			})),
			...report.passedChecks.map((c) => ({
				name: c.name,
				status: "✅ 正常",
				durationMs: c.durationMs,
				detail: "-",
			})),
		];

		const tableRows = allChecks
			.map(
				(c) => `| ${c.name} | ${c.status} | ${c.durationMs}ms | ${c.detail} |`,
			)
			.join("\n");

		const body = [
			"## ヘルスチェック結果",
			"",
			"| チェック | 状態 | レイテンシ | 詳細 |",
			"| --- | --- | --- | --- |",
			tableRows,
			"",
			"## Fingerprint",
			"",
			`\`${fingerprint}\``,
			"",
			`**検知時刻:** ${report.timestamp}`,
			"",
			"---",
			"*This issue was automatically created by the health check monitoring system.*",
		].join("\n");

		await this.request(
			"create health check issue",
			`${GITHUB_API_BASE}/repos/${this.repository.fullName}/issues`,
			{
				method: "POST",
				headers: this.headers(true),
				body: JSON.stringify({
					title,
					body,
					labels: ["health-check", "auto-reported"],
				}),
			},
			false,
		);

		this.log.info("GitHub health check issue created successfully");
	}

	/**
	 * Create a GitHub Issue for an error report.
	 * POST is attempted once because retrying an ambiguous network failure could
	 * create duplicate issues. Callers keep this operation non-fatal.
	 */
	async createIssue(report: ErrorReport, fingerprint: string): Promise<void> {
		const title = `[Auto] Worker Error: ${report.errorMessage.slice(0, 80)}`;

		const body = [
			"## Error Details",
			"",
			"| Field | Value |",
			"| --- | --- |",
			`| **Error** | \`${report.errorMessage}\` |`,
			`| **Request ID** | \`${report.requestId}\` |`,
			`| **Workflow ID** | \`${report.workflowId}\` |`,
			...(report.step ? [`| **Step** | \`${report.step}\` |`] : []),
			`| **Duration** | ${report.durationMs}ms |`,
			`| **Steps Completed** | ${report.stepCount} |`,
			`| **Timestamp** | ${report.timestamp} |`,
			"",
			"## Fingerprint",
			"",
			`\`${fingerprint}\``,
			"",
			"---",
			"*This issue was automatically created by the error monitoring system.*",
		].join("\n");

		await this.request(
			"create issue",
			`${GITHUB_API_BASE}/repos/${this.repository.fullName}/issues`,
			{
				method: "POST",
				headers: this.headers(true),
				body: JSON.stringify({
					title,
					body,
					labels: ["bug", "auto-reported"],
				}),
			},
			false,
		);

		this.log.info("GitHub issue created successfully");
	}
}

export const createGitHubIssueClient = (
	token: string,
	log?: Logger,
	repository: GitHubRepositoryConfig = DEFAULT_RUNTIME_CONFIG.githubRepository,
): GitHubIssueClient => {
	return new GitHubIssueClient(token, log, repository);
};
