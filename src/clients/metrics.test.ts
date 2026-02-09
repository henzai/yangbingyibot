import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../utils/logger";
import {
	createMetricsClient,
	type DiscordWebhookMetricData,
	type GeminiMetricData,
	type KVCacheMetricData,
	type MetricData,
	MetricsClient,
	NoOpMetricsClient,
	type WorkflowMetricData,
} from "./metrics";

// Mock logger
const mockLogger: Logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trackTiming: vi.fn(),
	withContext: vi.fn(() => mockLogger),
} as unknown as Logger;

// Mock Analytics Engine Dataset
const createMockDataset = () => ({
	writeDataPoint: vi.fn(),
});

describe("MetricsClient", () => {
	let mockDataset: ReturnType<typeof createMockDataset>;
	let metrics: MetricsClient;

	beforeEach(() => {
		vi.clearAllMocks();
		mockDataset = createMockDataset();
		metrics = new MetricsClient(
			mockDataset as unknown as AnalyticsEngineDataset,
			mockLogger,
		);
	});

	describe("recordGeminiCall", () => {
		it("writes data point with correct structure for success", () => {
			const data: GeminiMetricData = {
				requestId: "req_abc123",
				success: true,
				durationMs: 1500,
				retryCount: 0,
			};

			metrics.recordGeminiCall(data);

			expect(mockDataset.writeDataPoint).toHaveBeenCalledWith({
				indexes: ["req_abc123"],
				blobs: ["gemini_api_call", "req_abc123"],
				doubles: [1500, 1, 0],
			});
		});

		it("records failure with success=0", () => {
			const data: GeminiMetricData = {
				requestId: "req_xyz789",
				success: false,
				durationMs: 500,
				retryCount: 2,
			};

			metrics.recordGeminiCall(data);

			expect(mockDataset.writeDataPoint).toHaveBeenCalledWith({
				indexes: ["req_xyz789"],
				blobs: ["gemini_api_call", "req_xyz789"],
				doubles: [500, 0, 2],
			});
		});

		it("defaults retryCount to 0 when not provided", () => {
			const data: GeminiMetricData = {
				requestId: "req_123",
				success: true,
				durationMs: 100,
			};

			metrics.recordGeminiCall(data);

			expect(mockDataset.writeDataPoint).toHaveBeenCalledWith({
				indexes: ["req_123"],
				blobs: ["gemini_api_call", "req_123"],
				doubles: [100, 1, 0],
			});
		});

		it("truncates long requestId in index to 96 bytes", () => {
			const longRequestId = `req_${"a".repeat(100)}`;
			const data: GeminiMetricData = {
				requestId: longRequestId,
				success: true,
				durationMs: 100,
			};

			metrics.recordGeminiCall(data);

			expect(mockDataset.writeDataPoint).toHaveBeenCalledWith({
				indexes: [longRequestId.substring(0, 96)],
				blobs: ["gemini_api_call", longRequestId],
				doubles: [100, 1, 0],
			});
		});
	});

	describe("recordWorkflowComplete", () => {
		it("writes data point with correct structure", () => {
			const data: WorkflowMetricData = {
				requestId: "req_workflow",
				workflowId: "wf_abc123",
				success: true,
				durationMs: 5000,
				stepCount: 5,
				fromCache: true,
			};

			metrics.recordWorkflowComplete(data);

			expect(mockDataset.writeDataPoint).toHaveBeenCalledWith({
				indexes: ["req_workflow"],
				blobs: ["workflow_complete", "req_workflow", "wf_abc123"],
				doubles: [5000, 1, 5, 1],
			});
		});

		it("records failure with fromCache=false", () => {
			const data: WorkflowMetricData = {
				requestId: "req_fail",
				workflowId: "wf_fail",
				success: false,
				durationMs: 1000,
				stepCount: 3,
				fromCache: false,
			};

			metrics.recordWorkflowComplete(data);

			expect(mockDataset.writeDataPoint).toHaveBeenCalledWith({
				indexes: ["req_fail"],
				blobs: ["workflow_complete", "req_fail", "wf_fail"],
				doubles: [1000, 0, 3, 0],
			});
		});
	});

	describe("recordKVCacheAccess", () => {
		it("records cache hit correctly", () => {
			const data: KVCacheMetricData = {
				requestId: "req_cache",
				success: true,
				durationMs: 5,
				cacheHit: true,
				operation: "get",
			};

			metrics.recordKVCacheAccess(data);

			expect(mockDataset.writeDataPoint).toHaveBeenCalledWith({
				indexes: ["req_cache"],
				blobs: ["kv_cache_access", "req_cache", "get"],
				doubles: [5, 1, 1],
			});
		});

		it("records cache miss correctly", () => {
			const data: KVCacheMetricData = {
				requestId: "req_miss",
				success: true,
				durationMs: 10,
				cacheHit: false,
				operation: "get",
			};

			metrics.recordKVCacheAccess(data);

			expect(mockDataset.writeDataPoint).toHaveBeenCalledWith({
				indexes: ["req_miss"],
				blobs: ["kv_cache_access", "req_miss", "get"],
				doubles: [10, 1, 0],
			});
		});

		it("records put operation", () => {
			const data: KVCacheMetricData = {
				requestId: "req_put",
				success: true,
				durationMs: 15,
				cacheHit: false,
				operation: "put",
			};

			metrics.recordKVCacheAccess(data);

			expect(mockDataset.writeDataPoint).toHaveBeenCalledWith({
				indexes: ["req_put"],
				blobs: ["kv_cache_access", "req_put", "put"],
				doubles: [15, 1, 0],
			});
		});
	});

	describe("recordDiscordWebhook", () => {
		it("writes data point with status code", () => {
			const data: DiscordWebhookMetricData = {
				requestId: "req_discord",
				success: true,
				durationMs: 200,
				retryCount: 0,
				statusCode: 200,
			};

			metrics.recordDiscordWebhook(data);

			expect(mockDataset.writeDataPoint).toHaveBeenCalledWith({
				indexes: ["req_discord"],
				blobs: ["discord_webhook", "req_discord"],
				doubles: [200, 1, 0, 200],
			});
		});

		it("records failure with retries", () => {
			const data: DiscordWebhookMetricData = {
				requestId: "req_discord_fail",
				success: false,
				durationMs: 3000,
				retryCount: 2,
				statusCode: 500,
			};

			metrics.recordDiscordWebhook(data);

			expect(mockDataset.writeDataPoint).toHaveBeenCalledWith({
				indexes: ["req_discord_fail"],
				blobs: ["discord_webhook", "req_discord_fail"],
				doubles: [3000, 0, 2, 500],
			});
		});

		it("defaults statusCode to 0 when not provided", () => {
			const data: DiscordWebhookMetricData = {
				requestId: "req_no_status",
				success: false,
				durationMs: 1000,
				retryCount: 2,
			};

			metrics.recordDiscordWebhook(data);

			expect(mockDataset.writeDataPoint).toHaveBeenCalledWith({
				indexes: ["req_no_status"],
				blobs: ["discord_webhook", "req_no_status"],
				doubles: [1000, 0, 2, 0],
			});
		});
	});

	describe("recordSheetsApiCall", () => {
		it("writes data point with correct structure", () => {
			const data: MetricData = {
				requestId: "req_sheets",
				success: true,
				durationMs: 800,
			};

			metrics.recordSheetsApiCall(data);

			expect(mockDataset.writeDataPoint).toHaveBeenCalledWith({
				indexes: ["req_sheets"],
				blobs: ["sheets_api_call", "req_sheets"],
				doubles: [800, 1],
			});
		});

		it("records failure", () => {
			const data: MetricData = {
				requestId: "req_sheets_fail",
				success: false,
				durationMs: 5000,
			};

			metrics.recordSheetsApiCall(data);

			expect(mockDataset.writeDataPoint).toHaveBeenCalledWith({
				indexes: ["req_sheets_fail"],
				blobs: ["sheets_api_call", "req_sheets_fail"],
				doubles: [5000, 0],
			});
		});
	});

	describe("error handling", () => {
		it("does not throw when writeDataPoint fails", () => {
			mockDataset.writeDataPoint.mockImplementation(() => {
				throw new Error("Dataset error");
			});

			expect(() => {
				metrics.recordGeminiCall({
					requestId: "req_123",
					success: true,
					durationMs: 100,
				});
			}).not.toThrow();
		});

		it("logs warning when writeDataPoint fails", () => {
			mockDataset.writeDataPoint.mockImplementation(() => {
				throw new Error("Dataset error");
			});

			metrics.recordGeminiCall({
				requestId: "req_123",
				success: true,
				durationMs: 100,
			});

			expect(mockLogger.warn).toHaveBeenCalledWith(
				"Failed to write metric data point",
				{
					eventType: "gemini_api_call",
					error: "Dataset error",
				},
			);
		});
	});
});

describe("NoOpMetricsClient", () => {
	it("does nothing when called", () => {
		const noOp = new NoOpMetricsClient();

		// Should not throw
		noOp.recordGeminiCall({ requestId: "x", success: true, durationMs: 0 });
		noOp.recordWorkflowComplete({
			requestId: "x",
			workflowId: "w",
			success: true,
			durationMs: 0,
			stepCount: 0,
			fromCache: false,
		});
		noOp.recordKVCacheAccess({
			requestId: "x",
			success: true,
			durationMs: 0,
			cacheHit: true,
			operation: "get",
		});
		noOp.recordDiscordWebhook({
			requestId: "x",
			success: true,
			durationMs: 0,
			retryCount: 0,
		});
		noOp.recordSheetsApiCall({ requestId: "x", success: true, durationMs: 0 });
	});
});

describe("createMetricsClient", () => {
	it("creates a MetricsClient instance", () => {
		const mockDataset = createMockDataset();
		const client = createMetricsClient(
			mockDataset as unknown as AnalyticsEngineDataset,
		);

		expect(client).toBeInstanceOf(MetricsClient);
	});

	it("passes logger to MetricsClient", () => {
		const mockDataset = createMockDataset();
		mockDataset.writeDataPoint.mockImplementation(() => {
			throw new Error("test");
		});

		const client = createMetricsClient(
			mockDataset as unknown as AnalyticsEngineDataset,
			mockLogger,
		);

		client.recordGeminiCall({ requestId: "x", success: true, durationMs: 0 });

		expect(mockLogger.warn).toHaveBeenCalled();
	});
});
