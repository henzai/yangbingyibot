export enum LogLevel {
	ERROR = "ERROR",
	WARN = "WARN",
	INFO = "INFO",
	DEBUG = "DEBUG",
}

export interface LogContext {
	requestId?: string;
	workflowId?: string;
	step?: string;
	durationMs?: number;
	[key: string]: unknown;
}

interface StructuredLog {
	timestamp: string;
	level: LogLevel;
	message: string;
	requestId?: string;
	context?: LogContext;
}

export class Logger {
	private baseContext: LogContext;

	constructor(baseContext: LogContext = {}) {
		this.baseContext = baseContext;
	}

	/**
	 * Creates a new Logger instance with additional context
	 * Useful for adding request-scoped context like requestId
	 */
	withContext(context: LogContext): Logger {
		return new Logger({ ...this.baseContext, ...context });
	}

	private log(level: LogLevel, message: string, context?: LogContext) {
		const mergedContext = { ...this.baseContext, ...context };
		const { requestId, ...restContext } = mergedContext;

		const structuredLog: StructuredLog = {
			timestamp: new Date().toISOString(),
			level,
			message,
			...(requestId && { requestId }),
			...(Object.keys(restContext).length > 0 && { context: restContext }),
		};

		console.log(JSON.stringify(structuredLog));
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
}

export const logger = new Logger();
