import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyDiscordInteraction } from './verifyDiscordInteraction';

vi.mock('discord-interactions', () => ({
	verifyKey: vi.fn(),
	InteractionResponseType: {
		PONG: 1,
	},
}));

import { verifyKey } from 'discord-interactions';

const mockVerifyKey = vi.mocked(verifyKey);

type Bindings = { DISCORD_PUBLIC_KEY: string };

const mockExecutionCtx = {
	waitUntil: () => {},
	passThroughOnException: () => {},
} as unknown as ExecutionContext;

describe('verifyDiscordInteraction middleware', () => {
	let app: Hono<{ Bindings: Bindings }>;
	const testEnv: Bindings = { DISCORD_PUBLIC_KEY: 'test-key' };

	beforeEach(() => {
		vi.clearAllMocks();

		app = new Hono<{ Bindings: Bindings }>();
		app.post('/', verifyDiscordInteraction, (c) => {
			return c.json({ success: true });
		});
	});

	it('returns 401 when X-Signature-Ed25519 header is missing', async () => {
		const req = new Request('http://localhost/', {
			method: 'POST',
			headers: {
				'X-Signature-Timestamp': '1234567890',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ type: 2 }),
		});

		const res = await app.fetch(req, testEnv, mockExecutionCtx);

		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ message: 'invalid request signature' });
	});

	it('returns 401 when X-Signature-Timestamp header is missing', async () => {
		const req = new Request('http://localhost/', {
			method: 'POST',
			headers: {
				'X-Signature-Ed25519': 'abc123',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ type: 2 }),
		});

		const res = await app.fetch(req, testEnv, mockExecutionCtx);

		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ message: 'invalid request signature' });
	});

	it('returns 401 when verifyKey returns false', async () => {
		mockVerifyKey.mockReturnValue(false);

		const req = new Request('http://localhost/', {
			method: 'POST',
			headers: {
				'X-Signature-Ed25519': 'invalid-sig',
				'X-Signature-Timestamp': '1234567890',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ type: 2 }),
		});

		const res = await app.fetch(req, testEnv, mockExecutionCtx);

		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ message: 'invalid request signature' });
		expect(mockVerifyKey).toHaveBeenCalledWith(JSON.stringify({ type: 2 }), 'invalid-sig', '1234567890', 'test-key');
	});

	it('calls next() for valid PING requests', async () => {
		mockVerifyKey.mockReturnValue(true);

		const req = new Request('http://localhost/', {
			method: 'POST',
			headers: {
				'X-Signature-Ed25519': 'valid-sig',
				'X-Signature-Timestamp': '1234567890',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ type: 1 }),
		});

		const res = await app.fetch(req, testEnv, mockExecutionCtx);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ success: true });
	});

	it('calls next() for valid non-PING requests', async () => {
		mockVerifyKey.mockReturnValue(true);

		const req = new Request('http://localhost/', {
			method: 'POST',
			headers: {
				'X-Signature-Ed25519': 'valid-sig',
				'X-Signature-Timestamp': '1234567890',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ type: 2 }),
		});

		const res = await app.fetch(req, testEnv, mockExecutionCtx);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ success: true });
	});
});
