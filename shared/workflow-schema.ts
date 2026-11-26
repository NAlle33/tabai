import * as z from "zod";

export const BATCH_MAX_STEPS = 50;
const safeName = z.string().min(1).max(120).refine(
  (value) => !["__proto__", "prototype", "constructor"].includes(value),
  "reserved name",
);
export const scalarSchema = z.union([z.string().max(100_000), z.number().finite(), z.boolean()]);
const parameterName = safeName.refine(value => /^[A-Za-z][A-Za-z0-9_-]*$/.test(value), "parameter names must start with a letter and contain only letters, digits, underscores or hyphens");
const bindingSchema = z.object({ $param: parameterName }).strict();
export const targetSchema = z.union([
  z.object({ selector: z.string().min(1), frameId: z.number().int().nonnegative().optional() }).strict(),
  z.object({ role: z.string().min(1), name: z.string(), frameId: z.number().int().nonnegative().optional() }).strict(),
]);
const conditionString = z.string().min(1).refine(value => value.trim().length > 0, "condition must not be blank");
export const expectationSchema = z.object({
  selector: conditionString.optional(),
  text: conditionString.optional(),
  predicate: conditionString.optional(),
  url: conditionString.optional(),
  fieldValue: z.object({ selector: conditionString, value: z.union([scalarSchema, bindingSchema]) }).strict().optional(),
  frameId: z.number().int().nonnegative().optional(),
  timeoutMs: z.number().int().positive().max(270_000).optional(),
  state: z.enum(["attached", "visible", "hidden", "detached"]).optional(),
  stableForMs: z.number().int().min(0).max(270_000).optional(),
}).strict().superRefine((value, ctx) => {
  const criteria = [value.selector, value.text, value.predicate, value.url, value.fieldValue];
  if (criteria.filter((criterion) => criterion !== undefined).length !== 1) {
    ctx.addIssue({ code: "custom", message: "expect needs exactly one criterion" });
  }
  if (value.frameId !== undefined && (value.predicate !== undefined || value.url !== undefined)) {
    ctx.addIssue({ code: "custom", message: "predicate and URL expectations use the main frame" });
  }
  if (value.state !== undefined && value.selector === undefined) {
    ctx.addIssue({ code: "custom", message: "state requires a selector" });
  }
});
export const actionSchema = z.object({
  tool: z.string().min(1).max(100),
  args: z.record(z.string(), z.unknown()).optional(),
  target: targetSchema.optional(),
  expect: expectationSchema.optional(),
}).strict();
export const parameterSchema = z.object({
  type: z.enum(["string", "number", "boolean"]),
  required: z.boolean().optional(),
  default: scalarSchema.optional(),
  description: z.string().max(1000).optional(),
}).strict().refine(p => p.default === undefined || typeof p.default === p.type, "default does not match parameter type");
export const parametersSchema = z.record(parameterName, parameterSchema);
export const recipeSchema = z.union([
  z.array(actionSchema), // Existing stores can contain empty or long legacy recipes.
  z.object({
    version: z.literal(2),
    actions: z.array(actionSchema).min(1).max(BATCH_MAX_STEPS),
    parameters: parametersSchema.default({}),
    description: z.string().max(2000).optional(),
  }).strict(),
]);
export type Action = z.infer<typeof actionSchema>;
export type Recipe = z.infer<typeof recipeSchema>;
export type Parameters = z.infer<typeof parametersSchema>;

/** Reserved name prefix of a parameter that carries a secret. The stored
 * parameter schema stays unchanged, so a store written by this code remains
 * readable by servers that still run an older bundle; the panel masks such
 * parameters by name. */
export const SECRET_PARAMETER_PREFIX = "secret_";
export const isSecretParameter = (name: string): boolean => name.startsWith(SECRET_PARAMETER_PREFIX);

/** Walk JSON data, never program source. Replacements are scalar and are not
 * recursively interpreted; a supplied string containing {{...}} remains data. */
export function bindParameters(actions: Action[], definitions: Parameters = {}, inputs: Record<string, unknown> = {}): Action[] {
  parametersSchema.parse(definitions);
  const values: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(inputs)) {
    parameterName.parse(key);
    if (!Object.hasOwn(definitions, key)) {
      throw new Error(`Unknown parameter: ${key}`);
    }
  }
  for (const [key, definition] of Object.entries(definitions)) {
    const value = Object.hasOwn(inputs, key) ? inputs[key] : definition.default;
    if (value === undefined) {
      if (definition.required !== false) {
        throw new Error(`Missing parameter: ${key}`);
      }
    } else {
      scalarSchema.parse(value);
      if (typeof value !== definition.type) {
        throw new Error(`Wrong type for parameter: ${key} (expected ${definition.type})`);
      }
      values[key] = value;
    }
  }
  const get = (key: string) => {
    if (!Object.hasOwn(values, key)) {
      throw new Error(`Missing or unknown parameter: ${key}`);
    }
    return values[key];
  };
  let nodes = 0;
  const visit = (value: unknown, depth = 0): unknown => {
    if (++nodes > 50_000 || depth > 40) {
      throw new Error("Recipe template is too large or deeply nested");
    }
    if (typeof value === "string") {
      return value.replace(/\{\{([\w-]+)\}\}/g, (_, key) => String(get(key)));
    }
    if (Array.isArray(value)) {
      return value.map((item) => visit(item, depth + 1));
    }
    if (value && typeof value === "object") {
      if (Object.hasOwn(value, "$param")) {
        const binding = bindingSchema.parse(value);
        return get(binding.$param);
      }
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        safeName.parse(key);
        result[key] = visit(item, depth + 1);
      }
      return result;
    }
    return value;
  };
  const isBinding = (value: unknown) => (
    typeof value === "string"
      ? /\{\{[\w-]+\}\}/.test(value)
      : !!value && typeof value === "object" && Object.hasOwn(value, "$param")
  );
  return actions.map((action) => {
    const nestedExpectation = action.args?.expect as { predicate?: unknown } | undefined;
    if ((action.tool === "javascript_tool" && isBinding(action.args?.text)) ||
        (action.tool === "wait_for" && isBinding(action.args?.predicate)) || isBinding(action.expect?.predicate) ||
        isBinding(nestedExpectation?.predicate))
      throw new Error("Parameters cannot be substituted into executable JavaScript or predicates; use typed expectations");
    // Tool names are the recipe's fixed program, not a parameterized input.
    if (isBinding(action.tool)) throw new Error("Tool names cannot be parameterized");
    return actionSchema.parse(visit(action));
  });
}

export function recipeActions(recipe: Recipe, inputs: Record<string, unknown> = {}): Action[] {
  return Array.isArray(recipe) ? bindParameters(recipe, {}, inputs) : bindParameters(recipe.actions, recipe.parameters, inputs);
}
