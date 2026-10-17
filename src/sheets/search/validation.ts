import tools from "./tools.schema.json";
import type { ToolName } from "./types";

// This deliberately implements only the vocabulary in the checked-in v0.2
// schemas. Extend this validator when extending that schema vocabulary. Provider adaptation is E.
type Schema = {
	type?: string;
	$ref?: string;
	$defs?: Record<string, Schema>;
	anyOf?: Schema[];
	enum?: unknown[];
	properties?: Record<string, Schema>;
	required?: string[];
	additionalProperties?: boolean;
	items?: Schema;
	minItems?: number;
	maxItems?: number;
	minLength?: number;
	maxLength?: number;
	minimum?: number;
	maximum?: number;
};
function matches(value: unknown, schema: Schema, root: Schema): boolean {
	if (schema.$ref) {
		const key = schema.$ref.replace(/^#\/\$defs\//, "");
		return !!root.$defs?.[key] && matches(value, root.$defs[key], root);
	}
	if (schema.anyOf) return schema.anyOf.some((s) => matches(value, s, root));
	if (schema.enum && !schema.enum.includes(value)) return false;
	switch (schema.type) {
		case "null":
			return value === null;
		case "string":
			return (
				typeof value === "string" &&
				value.length >= (schema.minLength ?? 0) &&
				value.length <= (schema.maxLength ?? Infinity)
			);
		case "boolean":
			return typeof value === "boolean";
		case "integer":
		case "number":
			return (
				typeof value === "number" &&
				Number.isFinite(value) &&
				(schema.type !== "integer" || Number.isInteger(value)) &&
				value >= (schema.minimum ?? -Infinity) &&
				value <= (schema.maximum ?? Infinity)
			);
		case "array":
			return (
				Array.isArray(value) &&
				value.length >= (schema.minItems ?? 0) &&
				value.length <= (schema.maxItems ?? Infinity) &&
				!!schema.items &&
				value.every((v) => matches(v, schema.items as Schema, root))
			);
		case "object": {
			if (typeof value !== "object" || value === null || Array.isArray(value))
				return false;
			const object = value as Record<string, unknown>;
			return (
				schema.additionalProperties === false &&
				!!schema.properties &&
				(schema.required ?? []).every((k) => Object.hasOwn(object, k)) &&
				Object.keys(object).every(
					(k) =>
						!!schema.properties?.[k] &&
						matches(object[k], schema.properties[k], root),
				)
			);
		}
		default:
			return false;
	}
}
export function validArguments(name: ToolName, value: unknown): boolean {
	const schema = tools.find((tool) => tool.name === name)?.parameters as
		| Schema
		| undefined;
	if (!schema) return false;
	return matches(value, schema, schema);
}
export const SEARCH_TOOL_SCHEMAS = tools;
