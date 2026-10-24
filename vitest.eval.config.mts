import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["tools/llm-eval/**/*.test.ts"],
	},
});
