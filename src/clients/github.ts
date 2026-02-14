import { getErrorMessage } from "../utils/errors";
import { logger as defaultLogger, type Logger } from "../utils/logger";

const GITHUB_API_BASE = "https://api.github.com";
const REPO_OWNER = "henzai";
const REPO_NAME = "yangbingyibot";

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

	constructor(token: string, log?: Logger) {
		this.token = token;
		this.log = log ?? defaultLogger;
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
	 * Fail-open: returns false on any error so that a new issue is created.
	 */
	async isDuplicate(fingerprint: string): Promise<boolean> {
		try {
			const query = encodeURIComponent(
				`repo:${REPO_OWNER}/${REPO_NAME} is:issue is:open label:auto-reported "${fingerprint}"`,
			);
			const res = await fetch(
				`${GITHUB_API_BASE}/search/issues?q=${query}&per_page=1`,
				{
					headers: {
						Authorization: `Bearer ${this.token}`,
						Accept: "application/vnd.github+json",
						"User-Agent": "yangbingyibot-error-reporter",
					},
				},
			);

			if (!res.ok) {
				this.log.warn("GitHub issue search failed", {
					statusCode: res.status,
				});
				return false;
			}

			const data = (await res.json()) as { total_count: number };
			return data.total_count > 0;
		} catch (error) {
			this.log.warn("GitHub issue search error (fail-open)", {
				error: getErrorMessage(error),
			});
			return false;
		}
	}

	/**
	 * Create a GitHub Issue for a health check failure.
	 * Non-fatal: logs warnings but does not throw on failure.
	 */
	async createHealthCheckIssue(
		report: HealthCheckReport,
		fingerprint: string,
	): Promise<boolean> {
		try {
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
					(c) =>
						`| ${c.name} | ${c.status} | ${c.durationMs}ms | ${c.detail} |`,
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

			const res = await fetch(
				`${GITHUB_API_BASE}/repos/${REPO_OWNER}/${REPO_NAME}/issues`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${this.token}`,
						Accept: "application/vnd.github+json",
						"User-Agent": "yangbingyibot-error-reporter",
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						title,
						body,
						labels: ["health-check", "auto-reported"],
					}),
				},
			);

			if (!res.ok) {
				this.log.warn("GitHub health check issue creation failed", {
					statusCode: res.status,
				});
				return false;
			}

			this.log.info("GitHub health check issue created successfully");
			return true;
		} catch (error) {
			this.log.warn("GitHub health check issue creation error", {
				error: getErrorMessage(error),
			});
			return false;
		}
	}

	/**
	 * Create a GitHub Issue for an error report.
	 * Non-fatal: logs warnings but does not throw on failure.
	 */
	async createIssue(
		report: ErrorReport,
		fingerprint: string,
	): Promise<boolean> {
		try {
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

			const res = await fetch(
				`${GITHUB_API_BASE}/repos/${REPO_OWNER}/${REPO_NAME}/issues`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${this.token}`,
						Accept: "application/vnd.github+json",
						"User-Agent": "yangbingyibot-error-reporter",
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						title,
						body,
						labels: ["bug", "auto-reported"],
					}),
				},
			);

			if (!res.ok) {
				this.log.warn("GitHub issue creation failed", {
					statusCode: res.status,
				});
				return false;
			}

			this.log.info("GitHub issue created successfully");
			return true;
		} catch (error) {
			this.log.warn("GitHub issue creation error", {
				error: getErrorMessage(error),
			});
			return false;
		}
	}
}

export const createGitHubIssueClient = (
	token: string,
	log?: Logger,
): GitHubIssueClient => {
	return new GitHubIssueClient(token, log);
};
