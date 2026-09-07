import { ConfigError } from "../config";
import type { Logger } from "../utils/logger";
import type { LlmSelection } from "./providerCatalog";
import { GeminiLlmGateway } from "./providers/gemini";
import type { ILlmGateway } from "./types";

export type GatewayFactories = Readonly<
	Record<string, (apiKey: string, log?: Logger) => ILlmGateway>
>;
const FACTORIES: GatewayFactories = {
	gemini: (apiKey, log) => new GeminiLlmGateway(apiKey, log),
};

export function createLlmGateway(
	selection: LlmSelection,
	log?: Logger,
	factories: GatewayFactories = FACTORIES,
): ILlmGateway {
	if (!Object.hasOwn(factories, selection.provider))
		throw new ConfigError(
			"LLM_PROVIDER",
			"provider is not supported by this build",
		);
	return factories[selection.provider](selection.apiKey, log);
}
