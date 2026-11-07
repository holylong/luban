import { createRequire } from "node:module";
import type { ValidateFunction } from "ajv";
import type { ToolDefinition } from "./types.js";

// Validate without coercing, deleting, or filling arguments: approvals and
// execution must observe exactly the same request the model submitted.
const options = { strict: false, allErrors: true, validateFormats: false, addUsedSchema: false };
type AjvInstance = { compile(schema: Record<string, unknown>): ValidateFunction; removeSchema(schema: object): unknown };
type AjvConstructor = new (settings: Record<string, unknown>) => AjvInstance;
const cache = new WeakMap<object, ValidateFunction>();
/**
 * Ajv plus its 2019-09 and 2020-12 engines only matter once the model actually
 * submits a tool call, and they are 80-odd module files. Loading them through
 * CommonJS on first use keeps this check synchronous (callers validate right
 * before executing) while keeping them off the startup path, where every file
 * read is scanned by the antivirus on Windows.
 */
let validators: AjvInstance[] | undefined;
function engines(): AjvInstance[] {
  if (validators) return validators;
  const require = createRequire(import.meta.url);
  const load = (specifier: string): AjvConstructor => {
    const loaded = require(specifier) as AjvConstructor | { default?: AjvConstructor };
    const constructor = typeof loaded === "function" ? loaded : loaded.default;
    if (typeof constructor !== "function") throw new Error(`cannot load ${specifier}`);
    return constructor;
  };
  validators = [load("ajv"), load("ajv/dist/2019.js"), load("ajv/dist/2020.js")].map(Engine => new Engine(options));
  return validators;
}

export function validateToolArguments(tool: ToolDefinition, args: Record<string, unknown>): void {
  const schema = tool.parameters;
  if (schema.$async === true) throw new Error(`invalid schema for ${tool.name}: asynchronous validation is not supported`);
  let validate = cache.get(schema);
  if (!validate) {
    const draft = String(schema.$schema ?? "");
    const validator = engines()[draft.includes("2020-12") ? 2 : draft.includes("2019-09") ? 1 : 0]!;
    try { validate = validator.compile(schema); }
    catch (error) { throw new Error(`invalid schema for ${tool.name}: ${error instanceof Error ? error.message : String(error)}`); }
    // Ajv also holds a strong schema cache. Keep lifetime ownership in our
    // WeakMap so regenerated plan/MCP schemas do not grow across sessions.
    validator.removeSchema(schema);
    cache.set(schema, validate);
  }
  if (!validate(args)) {
    const detail = validate.errors?.slice(0, 8).map(error => `${error.instancePath || "/"} ${error.message}${error.keyword === "required" ? ` (${error.params.missingProperty})` : ""}`).join("; ");
    throw new Error(`invalid arguments for ${tool.name}: ${detail}`);
  }
}

/** Also guard direct calls from integrations, outside the agent dispatcher. */
export function guardTool(tool: ToolDefinition): ToolDefinition {
  return { ...tool, async execute(args, signal, context) {
    signal.throwIfAborted();
    validateToolArguments(tool, args);
    return tool.execute(args, signal, context);
  } };
}
