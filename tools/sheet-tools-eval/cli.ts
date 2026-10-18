import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { config as loadDotenv } from "dotenv";
import { createLlmGateway } from "../../src/llm/factory";
import { EVAL_MODEL, runCli } from "./run";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "../..");

async function main(): Promise<number> {
	return runCli(process.argv.slice(2), {
		repoRoot,
		loadApiKey: () => {
			// Parsed into a private object so the key never enters process.env.
			const parsed: Record<string, string> = {};
			loadDotenv({
				path: resolve(repoRoot, ".env.local"),
				quiet: true,
				processEnv: parsed,
			});
			const key = parsed.OPENAI_API_KEY;
			if (!key) throw new Error("OPENAI_API_KEY is missing from .env.local");
			return key;
		},
		createGateway: (apiKey) =>
			createLlmGateway({ provider: "openai", model: EVAL_MODEL, apiKey }),
		gitCommit: async () =>
			(
				await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot })
			).stdout.trim(),
		isIgnored: async (path) => {
			try {
				await execFileAsync("git", ["check-ignore", "-q", path], {
					cwd: repoRoot,
				});
				return true;
			} catch {
				return false;
			}
		},
		print: (line) => console.log(line),
	});
}

main().then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		const message = error instanceof Error ? error.message : "unknown failure";
		console.error(`Sheet tools evaluation stopped: ${message}`);
		process.exitCode = 1;
	},
);
