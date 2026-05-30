import type { WorkflowMeta } from "./types.js";
import { parse } from "acorn";

type AnyNode = Node & { [key: string]: any; start: number; end: number };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Node: new () => AnyNode = require("acorn").Node as any;

const DETERMINISM_BLOCKLIST = /\bDate\s*\.\s*now\b|\bMath\s*\.\s*random\b|\bnew\s+Date\s*\(\s*\)/;

export function parseWorkflowMeta(script: string): WorkflowMeta {
    const { meta } = parseWorkflowScript(script);
    return meta;
}

export function transformWorkflowScript(script: string): string {
    const { body } = parseWorkflowScript(script);
    return body;
}

export function parseWorkflowScript(script: string): { meta: WorkflowMeta; body: string } {
    if (DETERMINISM_BLOCKLIST.test(script)) {
        throw new Error("Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable");
    }

    const ast = parse(script, {
        ecmaVersion: "latest",
        sourceType: "module",
        allowAwaitOutsideFunction: true,
        allowReturnOutsideFunction: true,
    }) as unknown as AnyNode;

    const first = ast.body?.[0] as AnyNode | undefined;
    if (first?.type !== "ExportNamedDeclaration") {
        throw new Error("`export const meta = { name, description, phases }` must be the first statement in the script");
    }

    const declaration = first.declaration as AnyNode | null;
    if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") {
        throw new Error("meta export must be `export const meta = ...`");
    }
    if (declaration.declarations.length !== 1) {
        throw new Error("meta export must declare only `meta`");
    }

    const declarator = declaration.declarations[0] as AnyNode;
    if (declarator.id?.type !== "Identifier" || declarator.id.name !== "meta") {
        throw new Error("meta export must declare `meta`");
    }
    if (!declarator.init) throw new Error("meta must have a literal value");

    const meta = evaluateLiteral(declarator.init, "meta") as WorkflowMeta;
    validateMeta(meta);

    const body = script.slice(0, first.start) + script.slice(first.end);
    return { meta, body };
}

function evaluateLiteral(node: AnyNode, path: string): unknown {
    switch (node.type) {
        case "ObjectExpression": {
            const out: Record<string, unknown> = {};
            for (const prop of node.properties as AnyNode[]) {
                if (prop.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
                if (prop.type !== "Property") throw new Error(`only plain properties allowed in ${path}`);
                if (prop.computed) throw new Error(`computed keys not allowed in ${path}`);
                if (prop.kind !== "init" || prop.method) throw new Error(`methods/accessors not allowed in ${path}`);
                const key = propertyKey(prop.key as AnyNode, path);
                if (key === "__proto__" || key === "constructor" || key === "prototype") {
                    throw new Error(`reserved key name not allowed in ${path}: ${key}`);
                }
                out[key] = evaluateLiteral(prop.value as AnyNode, `${path}.${key}`);
            }
            return out;
        }
        case "ArrayExpression":
            return (node.elements as Array<AnyNode | null>).map((element, index) => {
                if (!element) throw new Error(`sparse arrays not allowed in ${path}`);
                if (element.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
                return evaluateLiteral(element, `${path}[${index}]`);
            });
        case "Literal":
            return node.value;
        case "TemplateLiteral":
            if (node.expressions.length > 0) throw new Error(`template interpolation not allowed in ${path}`);
            return node.quasis.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw).join("");
        case "UnaryExpression":
            if (node.operator === "-" && node.argument?.type === "Literal" && typeof node.argument.value === "number") {
                return -node.argument.value;
            }
            throw new Error(`only negative-number unary allowed in ${path}`);
        default:
            throw new Error(`non-literal node type in ${path}: ${node.type}`);
    }
}

function propertyKey(node: AnyNode, path: string): string {
    if (node.type === "Identifier") return node.name;
    if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number")) {
        return String(node.value);
    }
    throw new Error(`unsupported key type in ${path}: ${node.type}`);
}

function validateMeta(meta: unknown): asserts meta is WorkflowMeta {
    if (!meta || typeof meta !== "object") throw new Error("meta must be an object");
    const value = meta as WorkflowMeta;
    if (typeof value.name !== "string" || !value.name.trim()) throw new Error("meta.name must be a non-empty string");
    if (typeof value.description !== "string" || !value.description.trim()) {
        throw new Error("meta.description must be a non-empty string");
    }
    if (value.whenToUse !== undefined && typeof value.whenToUse !== "string") {
        throw new Error("meta.whenToUse must be a string");
    }
    if (value.phases !== undefined) {
        if (!Array.isArray(value.phases)) throw new Error("meta.phases must be an array");
        for (const phase of value.phases) {
            if (!phase || typeof phase !== "object" || typeof phase.title !== "string") {
                throw new Error("each meta phase must have a title string");
            }
        }
    }
}