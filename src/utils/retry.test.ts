import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withRetry } from "./retry";

describe("withRetry", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("successful execution", () => {
		it("returns result on first attempt", async () => {
			const mockFn = vi.fn().mockResolvedValue("success");

			const promise = withRetry(mockFn);
			await vi.runAllTimersAsync();
			const result = await promise;

			expect(result).toBe("success");
			expect(mockFn).toHaveBeenCalledTimes(1);
		});

		it("returns result after retry", async () => {
			const mockFn = vi
				.fn()
				.mockRejectedValueOnce(new Error("temporary error"))
				.mockResolvedValueOnce("success");

			const promise = withRetry(mockFn);
			await vi.runAllTimersAsync();
			const result = await promise;

			expect(result).toBe("success");
			expect(mockFn).toHaveBeenCalledTimes(2);
		});
	});

	describe("retry behavior", () => {
		it("retries up to maxAttempts times", async () => {
			const mockFn = vi.fn().mockRejectedValue(new Error("persistent error"));

			// runAllTimersAsync() の実行中に reject するため、先に assertion を
			// 繋いでハンドラを登録しておく (vitest 4 は未処理の rejection を
			// Unhandled Error として検出し、テストが通っても exit code 1 になる)
			const promise = withRetry(mockFn, { maxAttempts: 3 });
			const assertion = expect(promise).rejects.toThrow("persistent error");
			await vi.runAllTimersAsync();
			await assertion;

			expect(mockFn).toHaveBeenCalledTimes(3);
		});

		it("uses exponential backoff", async () => {
			const mockFn = vi
				.fn()
				.mockRejectedValueOnce(new Error("error 1"))
				.mockRejectedValueOnce(new Error("error 2"))
				.mockResolvedValueOnce("success");

			const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			const promise = withRetry(mockFn, {
				initialDelayMs: 1000,
				backoffMultiplier: 2,
			});

			// Fast-forward through all timers
			await vi.runAllTimersAsync();
			await promise;

			// Verify delays: 1000ms, 2000ms (logged as JSON)
			const calls = consoleSpy.mock.calls.map((call) => call[0]);
			expect(calls.some((c) => c.includes('"delayMs":1000'))).toBe(true);
			expect(calls.some((c) => c.includes('"delayMs":2000'))).toBe(true);

			consoleSpy.mockRestore();
		});

		it("caps delay at maxDelayMs", async () => {
			const mockFn = vi
				.fn()
				.mockRejectedValueOnce(new Error("error 1"))
				.mockRejectedValueOnce(new Error("error 2"))
				.mockResolvedValueOnce("success");

			const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			const promise = withRetry(mockFn, {
				initialDelayMs: 5000,
				backoffMultiplier: 3,
				maxDelayMs: 8000,
			});

			await vi.runAllTimersAsync();
			await promise;

			// First retry: 5000ms, second retry: min(15000, 8000) = 8000ms (logged as JSON)
			const calls = consoleSpy.mock.calls.map((call) => call[0]);
			expect(calls.some((c) => c.includes('"delayMs":5000'))).toBe(true);
			expect(calls.some((c) => c.includes('"delayMs":8000'))).toBe(true);

			consoleSpy.mockRestore();
		});
	});

	describe("shouldRetry callback", () => {
		it("stops retrying when shouldRetry returns false", async () => {
			const mockFn = vi
				.fn()
				.mockRejectedValue(new Error("non-retryable error"));

			const shouldRetry = (error: Error) => {
				return error.message !== "non-retryable error";
			};

			const promise = withRetry(mockFn, { maxAttempts: 3 }, shouldRetry);
			const assertion = expect(promise).rejects.toThrow("non-retryable error");
			await vi.runAllTimersAsync();
			await assertion;

			expect(mockFn).toHaveBeenCalledTimes(1);
		});

		it("continues retrying for retryable errors", async () => {
			const mockFn = vi
				.fn()
				.mockRejectedValueOnce(new Error("retryable error"))
				.mockResolvedValueOnce("success");

			const shouldRetry = (error: Error) => {
				return error.message.includes("retryable");
			};

			const promise = withRetry(mockFn, {}, shouldRetry);
			await vi.runAllTimersAsync();
			const result = await promise;

			expect(result).toBe("success");
			expect(mockFn).toHaveBeenCalledTimes(2);
		});

		it("classifies rate limit errors as retryable", async () => {
			const mockFn = vi
				.fn()
				.mockRejectedValueOnce(new Error("rate limit exceeded"))
				.mockResolvedValueOnce("success");

			const shouldRetry = (error: Error) => {
				const msg = error.message.toLowerCase();
				return msg.includes("quota") || msg.includes("rate limit");
			};

			const promise = withRetry(mockFn, {}, shouldRetry);
			await vi.runAllTimersAsync();
			const result = await promise;

			expect(result).toBe("success");
			expect(mockFn).toHaveBeenCalledTimes(2);
		});

		it("classifies network errors as retryable", async () => {
			const mockFn = vi
				.fn()
				.mockRejectedValueOnce(new Error("network timeout"))
				.mockResolvedValueOnce("success");

			const shouldRetry = (error: Error) => {
				const msg = error.message.toLowerCase();
				return msg.includes("network") || msg.includes("timeout");
			};

			const promise = withRetry(mockFn, {}, shouldRetry);
			await vi.runAllTimersAsync();
			const result = await promise;

			expect(result).toBe("success");
			expect(mockFn).toHaveBeenCalledTimes(2);
		});
	});

	describe("error handling", () => {
		it("throws last error after all retries exhausted", async () => {
			const error1 = new Error("error 1");
			const error2 = new Error("error 2");
			const error3 = new Error("final error");

			const mockFn = vi
				.fn()
				.mockRejectedValueOnce(error1)
				.mockRejectedValueOnce(error2)
				.mockRejectedValueOnce(error3);

			const promise = withRetry(mockFn, { maxAttempts: 3 });
			const assertion = expect(promise).rejects.toThrow("final error");
			await vi.runAllTimersAsync();
			await assertion;
		});

		it("converts non-Error values to Error", async () => {
			const mockFn = vi.fn().mockRejectedValue("string error");

			const promise = withRetry(mockFn, { maxAttempts: 1 });
			const assertion = expect(promise).rejects.toThrow("string error");
			await vi.runAllTimersAsync();
			await assertion;
		});
	});

	describe("configuration", () => {
		it("uses default configuration when not provided", async () => {
			const mockFn = vi
				.fn()
				.mockRejectedValueOnce(new Error("error"))
				.mockResolvedValueOnce("success");

			const promise = withRetry(mockFn);
			await vi.runAllTimersAsync();
			const result = await promise;

			expect(result).toBe("success");
		});

		it("merges partial config with defaults", async () => {
			const mockFn = vi
				.fn()
				.mockRejectedValueOnce(new Error("error"))
				.mockResolvedValueOnce("success");

			const promise = withRetry(mockFn, { maxAttempts: 2 });
			await vi.runAllTimersAsync();
			const result = await promise;

			expect(result).toBe("success");
		});
	});

	describe("logging", () => {
		it("logs retry attempts", async () => {
			const mockFn = vi
				.fn()
				.mockRejectedValueOnce(new Error("temporary error"))
				.mockResolvedValueOnce("success");

			const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			const promise = withRetry(mockFn);
			await vi.runAllTimersAsync();
			await promise;

			// Logs are now JSON formatted
			const calls = consoleSpy.mock.calls.map((call) => call[0]);
			expect(
				calls.some(
					(c) => c.includes("Retry attempt") && c.includes("temporary error"),
				),
			).toBe(true);

			consoleSpy.mockRestore();
		});
	});
});
