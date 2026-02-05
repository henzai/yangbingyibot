/**
 * Generates a unique request ID for tracing requests across the system
 * Format: req_{timestamp}_{random}
 */
export function generateRequestId(): string {
	const timestamp = Date.now().toString(36);
	const random = Math.random().toString(36).substring(2, 9);
	return `req_${timestamp}_${random}`;
}
