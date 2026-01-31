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
}

export const logger = new Logger();
