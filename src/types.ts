import type { WorkflowParams } from "./workflows/types";

export type Bindings = {
	DISCORD_TOKEN: string;
	DISCORD_PUBLIC_KEY: string;
	DISCORD_APPLICATION_ID: string;
	GEMINI_API_KEY: string;
	GOOGLE_SERVICE_ACCOUNT: string;
	sushanshan_bot: KVNamespace;
	ANSWER_QUESTION_WORKFLOW: Workflow<WorkflowParams>;
	METRICS?: AnalyticsEngineDataset;
};
