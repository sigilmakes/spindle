import type { JsonSchema, SchemaValidationResult } from "./types.js";

function typeOf(value: unknown): string {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    return typeof value;
}

function validateValue(value: unknown, schema: JsonSchema, path: string, errors: string[]): void {
    if (schema.enum && !schema.enum.some((v) => Object.is(v, value))) {
        errors.push(`${path}: expected one of ${schema.enum.map(String).join(", ")}, got ${String(value)}`);
    }

    if (schema.type) {
        const actual = typeOf(value);
        const expected = schema.type === "integer" ? "number" : schema.type;
        if (actual !== expected) {
            errors.push(`${path}: expected ${schema.type}, got ${actual}`);
            return;
        }
        if (schema.type === "integer" && typeof value === "number" && !Number.isInteger(value)) {
            errors.push(`${path}: expected integer, got ${value}`);
        }
    }

    if (schema.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
        const obj = value as Record<string, unknown>;
        for (const required of schema.required ?? []) {
            if (!(required in obj)) errors.push(`${path}.${required}: required property missing`);
        }
        if (schema.properties) {
            for (const [key, childSchema] of Object.entries(schema.properties)) {
                if (key in obj) validateValue(obj[key], childSchema, `${path}.${key}`, errors);
            }
        }
        if (schema.additionalProperties === false && schema.properties) {
            const allowed = new Set(Object.keys(schema.properties));
            for (const key of Object.keys(obj)) {
                if (!allowed.has(key)) errors.push(`${path}.${key}: additional property not allowed`);
            }
        }
    }

    if (schema.type === "array" && Array.isArray(value) && schema.items) {
        value.forEach((item, index) => validateValue(item, schema.items!, `${path}[${index}]`, errors));
    }
}

export function validateSchema(value: unknown, schema: JsonSchema): SchemaValidationResult {
    const errors: string[] = [];
    validateValue(value, schema, "$", errors);
    return { ok: errors.length === 0, value, errors };
}

function stripFence(text: string): string {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    return fenced ? fenced[1].trim() : text.trim();
}

export function extractJson(text: string): unknown {
    const structured = text.match(/<structured>([\s\S]*?)<\/structured>/i);
    if (structured) return JSON.parse(stripFence(structured[1]));

    const fenced = text.match(/```json\s*([\s\S]*?)```/i);
    if (fenced) return JSON.parse(fenced[1].trim());

    const trimmed = text.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed);

    const firstObj = trimmed.indexOf("{");
    const lastObj = trimmed.lastIndexOf("}");
    if (firstObj >= 0 && lastObj > firstObj) {
        return JSON.parse(trimmed.slice(firstObj, lastObj + 1));
    }

    const firstArr = trimmed.indexOf("[");
    const lastArr = trimmed.lastIndexOf("]");
    if (firstArr >= 0 && lastArr > firstArr) {
        return JSON.parse(trimmed.slice(firstArr, lastArr + 1));
    }

    throw new Error("No JSON object or array found in subagent output");
}

export function buildSchemaPrompt(schema: JsonSchema): string {
    return [
        "## Structured thread output",
        "Your caller supplied a JSON Schema. Your final answer MUST include one <structured> block containing only valid JSON that satisfies this schema.",
        "Do not put prose inside the <structured> block.",
        "Schema:",
        "```json",
        JSON.stringify(schema, null, 2),
        "```",
        "Example shape:",
        "<structured>",
        "{\"ok\": true}",
        "</structured>",
    ].join("\n");
}
