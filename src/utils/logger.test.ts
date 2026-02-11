import { describe, expect, it, vi } from "vitest";
import { Logger, LogLevel, logger } from "./logger";

describe("Logger", () => {
	describe("インスタンス生成", () => {
		it("デフォルトコンストラクタで Logger が作成できる", () => {
			const log = new Logger();
			expect(log).toBeInstanceOf(Logger);
		});

		it("logger シングルトンが Logger インスタンスである", () => {
			expect(logger).toBeInstanceOf(Logger);
		});
	});

	describe("コンテキストマージ (withContext)", () => {
		it("withContext が新しい Logger インスタンスを返す（元のインスタンスを変更しない）", () => {
			const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			const original = new Logger({ step: "step1" });
			const derived = original.withContext({ workflowId: "wf-1" });

			expect(derived).toBeInstanceOf(Logger);
			expect(derived).not.toBe(original);

			// 元のインスタンスには workflowId が含まれないことを確認
			original.info("original");
			const originalOutput = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(originalOutput.context).toEqual({ step: "step1" });

			derived.info("derived");
			const derivedOutput = JSON.parse(consoleSpy.mock.calls[1][0]);
			expect(derivedOutput.context).toEqual({
				step: "step1",
				workflowId: "wf-1",
			});

			consoleSpy.mockRestore();
		});

		it("基本コンテキストと追加コンテキストがマージされる", () => {
			const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			const log = new Logger({ step: "step1" });
			const derived = log.withContext({ workflowId: "wf-1" });

			derived.info("test");
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.context).toEqual({ step: "step1", workflowId: "wf-1" });

			consoleSpy.mockRestore();
		});

		it("追加コンテキストが基本コンテキストを上書きする", () => {
			const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			const log = new Logger({ step: "step1" });
			const derived = log.withContext({ step: "step2" });

			derived.info("test");
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.context).toEqual({ step: "step2" });

			consoleSpy.mockRestore();
		});
	});

	describe("構造化ログ出力", () => {
		it.each([
			{ method: "error" as const, level: LogLevel.ERROR },
			{ method: "warn" as const, level: LogLevel.WARN },
			{ method: "info" as const, level: LogLevel.INFO },
			{ method: "debug" as const, level: LogLevel.DEBUG },
		])("$method が正しい level 値 ($level) を出力する", ({ method, level }) => {
			const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			const log = new Logger();
			log[method]("test message");

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.level).toBe(level);

			consoleSpy.mockRestore();
		});

		it("timestamp が ISO 形式である", () => {
			const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			const log = new Logger();
			log.info("test");

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.timestamp).toMatch(
				/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/,
			);

			consoleSpy.mockRestore();
		});

		it("message がそのまま出力される", () => {
			const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			const log = new Logger();
			log.info("hello world");

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.message).toBe("hello world");

			consoleSpy.mockRestore();
		});
	});

	describe("requestId の特殊処理", () => {
		it("requestId がトップレベルに配置される（context 内ではない）", () => {
			const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			const log = new Logger({ requestId: "req-123", step: "step1" });
			log.info("test");

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.requestId).toBe("req-123");
			expect(output.context?.requestId).toBeUndefined();

			consoleSpy.mockRestore();
		});

		it("requestId のみの場合、context プロパティが省略される", () => {
			const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			const log = new Logger({ requestId: "req-123" });
			log.info("test");

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.requestId).toBe("req-123");
			expect(output.context).toBeUndefined();

			consoleSpy.mockRestore();
		});

		it("requestId + 他プロパティの場合、requestId はトップレベル、他は context に入る", () => {
			const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			const log = new Logger({
				requestId: "req-123",
				workflowId: "wf-1",
				step: "step1",
			});
			log.info("test");

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.requestId).toBe("req-123");
			expect(output.context).toEqual({ workflowId: "wf-1", step: "step1" });

			consoleSpy.mockRestore();
		});
	});

	describe("context の条件付き出力", () => {
		it("追加コンテキストなしの場合、context プロパティが省略される", () => {
			const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			const log = new Logger();
			log.info("test");

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.context).toBeUndefined();

			consoleSpy.mockRestore();
		});

		it("追加コンテキストありの場合、context プロパティが含まれる", () => {
			const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			const log = new Logger({ step: "step1" });
			log.info("test");

			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.context).toEqual({ step: "step1" });

			consoleSpy.mockRestore();
		});
	});
});
