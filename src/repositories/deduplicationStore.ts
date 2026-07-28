export class DeduplicationStore {
	constructor(private readonly kv: KVNamespace) {}

	async isMarked(key: string): Promise<boolean> {
		return (await this.kv.get(key)) !== null;
	}

	async mark(key: string, ttlSeconds: number): Promise<void> {
		await this.kv.put(key, "1", { expirationTtl: ttlSeconds });
	}
}

export function createDeduplicationStore(kv: KVNamespace): DeduplicationStore {
	return new DeduplicationStore(kv);
}
