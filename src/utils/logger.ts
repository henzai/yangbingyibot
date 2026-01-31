export enum LogLevel {
	ERROR = 'ERROR',
	WARN = 'WARN',
	INFO = 'INFO',
	DEBUG = 'DEBUG',
}

interface LogContext {
	[key: string]: any;
}

class Logger {
	private includeTimestamp = true;

	private log(level: LogLevel, message: string, context?: LogContext) {
		const timestamp = this.includeTimestamp ? new Date().toISOString() : '';
		const contextStr = context ? ` | ${JSON.stringify(context)}` : '';
		console.log(`${timestamp} [${level}] ${message}${contextStr}`);
	}

	error(message: string, context?: LogContext) {
		this.log(LogLevel.ERROR, message, context);
	}

	warn(message: string, context?: LogContext) {
		this.log(LogLevel.WARN, message, context);
	}

	info(message: string, context?: LogContext) {
		this.log(LogLevel.INFO, message, context);
	}

	debug(message: string, context?: LogContext) {
		this.log(LogLevel.DEBUG, message, context);
	}

	// Performance timing wrapper
	async trackTiming<T>(operation: string, fn: () => Promise<T>, metadata?: LogContext): Promise<T> {
		const startTime = Date.now();
		let success = false;

		try {
			const result = await fn();
			success = true;
			return result;
		} finally {
			const durationMs = Date.now() - startTime;
			this.info(`Performance: ${operation}`, {
				durationMs,
				success,
				...metadata,
			});
		}
	}
}

export const logger = new Logger();
