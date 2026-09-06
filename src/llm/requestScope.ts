import { normalizeLlmError } from "./errors";

/** One budget for attempts, backoff, streaming, and time spent by the consumer. */
export class LlmRequestScope {
	private readonly controller = new AbortController();
	private readonly timer: ReturnType<typeof setTimeout>;
	private readonly cancel = () =>
		this.controller.abort(new DOMException("Cancelled", "AbortError"));
	readonly signal = this.controller.signal;

	constructor(
		private readonly provider: string,
		timeoutMs: number,
		private readonly callerSignal?: AbortSignal,
	) {
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
			throw new RangeError("LLM timeoutMs must be a finite positive number");
		}
		this.timer = setTimeout(
			() => {
				this.controller.abort(
					new DOMException("Deadline exceeded", "TimeoutError"),
				);
			},
			Math.min(timeoutMs, 90_000),
		);
		callerSignal?.addEventListener("abort", this.cancel, { once: true });
		if (callerSignal?.aborted) this.cancel();
	}

	/** Also bounds clients that do not settle promptly on AbortSignal. */
	async run<T>(operation: string, action: () => Promise<T>): Promise<T> {
		const abortError = () =>
			normalizeLlmError(this.signal.reason, this.provider, operation);
		if (this.signal.aborted) throw abortError();
		let onAbort = () => {};
		const aborted = new Promise<never>((_, reject) => {
			onAbort = () => reject(abortError());
			this.signal.addEventListener("abort", onAbort, { once: true });
		});
		try {
			return await Promise.race([action(), aborted]);
		} finally {
			this.signal.removeEventListener("abort", onAbort);
		}
	}

	async sleep(delayMs: number): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await this.run(
				"wait before retry",
				() =>
					new Promise<void>((resolve) => {
						timer = setTimeout(resolve, delayMs);
					}),
			);
		} finally {
			clearTimeout(timer);
		}
	}

	dispose(): void {
		clearTimeout(this.timer);
		this.callerSignal?.removeEventListener("abort", this.cancel);
		// Close the HTTP request when the consumer exits early as well.
		this.cancel();
	}
}
