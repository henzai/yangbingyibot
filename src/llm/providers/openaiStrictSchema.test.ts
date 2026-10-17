import { describe, expect, it } from "vitest";
import toolSchemas from "../../sheets/search/tools.schema.json";

// Documented Structured Outputs subset for strict function tools (2026-10-18):
// https://developers.openai.com/api/docs/guides/structured-outputs
// minLength/maxLength are listed as unsupported only for fine-tuned models.
const ALLOWED_KEYWORDS = new Set([
	"$defs",
	"$ref",
	"additionalProperties",
	"anyOf",
	"description",
	"enum",
	"items",
	"maxItems",
	"maxLength",
	"maximum",
	"minItems",
	"minLength",
	"minimum",
	"properties",
	"required",
	"type",
]);
const MAX_DEPTH = 10;
const MAX_PROPERTIES = 5_000;
const MAX_ENUM_VALUES = 1_000;
const MAX_NAME_AND_ENUM_CHARS = 120_000;

type Schema = Record<string, unknown>;

function isSchema(value: unknown): value is Schema {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inspect(parameters: Schema) {
	const problems: string[] = [];
	let properties = 0;
	let enumValues = 0;
	let chars = 0;
	let depth = 0;
	const visit = (schema: Schema, path: string, level: number): void => {
		depth = Math.max(depth, level);
		for (const keyword of Object.keys(schema)) {
			if (!ALLOWED_KEYWORDS.has(keyword))
				problems.push(`${path}: unsupported keyword ${keyword}`);
		}
		if (Array.isArray(schema.enum)) {
			enumValues += schema.enum.length;
			for (const value of schema.enum) chars += String(value).length;
		}
		if (isSchema(schema.properties)) {
			const keys = Object.keys(schema.properties);
			properties += keys.length;
			for (const key of keys) chars += key.length;
			if (schema.additionalProperties !== false)
				problems.push(`${path}: additionalProperties must be false`);
			const required = Array.isArray(schema.required) ? schema.required : [];
			if (
				required.length !== keys.length ||
				!keys.every((key) => required.includes(key))
			)
				problems.push(`${path}: every property must be required`);
			for (const [key, child] of Object.entries(schema.properties))
				if (isSchema(child)) visit(child, `${path}.${key}`, level + 1);
		}
		if (isSchema(schema.$defs)) {
			for (const [name, child] of Object.entries(schema.$defs)) {
				chars += name.length;
				if (isSchema(child)) visit(child, `${path}.$defs.${name}`, 1);
			}
		}
		if (isSchema(schema.items)) visit(schema.items, `${path}[]`, level + 1);
		if (Array.isArray(schema.anyOf))
			schema.anyOf.forEach((child, index) => {
				if (isSchema(child)) visit(child, `${path}|${index}`, level);
			});
	};
	visit(parameters, "$", 1);
	return { problems, properties, enumValues, chars, depth };
}

describe("sheet search tool schemas for OpenAI strict mode", () => {
	it.each(toolSchemas.map((tool) => [tool.name, tool] as const))(
		"keeps %s within the documented strict subset",
		(_name, tool) => {
			expect(tool).toMatchObject({ type: "function", strict: true });
			expect(typeof tool.description).toBe("string");
			const parameters = tool.parameters as Schema;
			expect(parameters.type).toBe("object");
			expect(parameters).not.toHaveProperty("anyOf");
			const result = inspect(parameters);
			expect(result.problems).toEqual([]);
			expect(result.depth).toBeLessThanOrEqual(MAX_DEPTH);
			expect(result.properties).toBeLessThanOrEqual(MAX_PROPERTIES);
			expect(result.enumValues).toBeLessThanOrEqual(MAX_ENUM_VALUES);
			expect(result.chars).toBeLessThanOrEqual(MAX_NAME_AND_ENUM_CHARS);
		},
	);

	it("rejects schemas outside the subset", () => {
		expect(
			inspect({
				type: "object",
				properties: { a: { type: "string", pattern: "x" }, b: {} },
				required: ["a"],
			}).problems,
		).toEqual([
			"$: additionalProperties must be false",
			"$: every property must be required",
			"$.a: unsupported keyword pattern",
		]);
	});
});
