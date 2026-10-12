import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ToolDefinition } from "./types.js";

// Validate without coercing, deleting, or filling arguments: approvals and
// execution must observe exactly the same request the model submitted.
const options = { strict: false, allErrors: true, validateFormats: false, addUsedSchema: false };
const validators = [new Ajv(options), new Ajv2019(options), new Ajv2020(options)];
const cache = new WeakMap<object, ValidateFunction>();

export function validateToolArguments(tool: ToolDefinition, args: Record<string, unknown>): void {
  const schema = tool.parameters;
  if (schema.$async === true) throw new Error(`invalid schema for ${tool.name}: asynchronous validation is not supported`);
  let validate = cache.get(schema);
  if (!validate) {
    const draft = String(schema.$schema ?? "");
    const validator = validators[draft.includes("2020-12") ? 2 : draft.includes("2019-09") ? 1 : 0];
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
  return { ...tool, async execute(args, signal) {
    signal.throwIfAborted();
    validateToolArguments(tool, args);
    return tool.execute(args, signal);
  } };
}
