// The tool listing both catalogs publish, and the local model's grammar built from it, keep the
// form callers and the local model's protocol were verified with: integers without the schema
// library's safe-integer range, no `propertyNames`, no zod e-mail pattern beside the e-mail
// format, unions as `anyOf` and literal unions as one `enum`, every argument object closed with
// `additionalProperties: false`, and identifiers, times, addresses and e-mail listed as formats.
// Validation itself is the schemas' own; this checks only what tools/list says.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as z from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { registerCatalog } from "../dist/tool-catalog.mjs";
import { RecipeStore } from "../dist/recipe-store.mjs";
import { RunHistory } from "../dist/run-history.mjs";
import { WorkflowControl } from "../dist/workflow-control.mjs";
import { recipeSchema } from "../dist/workflow-schema.mjs";
import { EXTENSION_VERSION } from "../dist/protocol.mjs";
import { toolInputObject } from "../dist/stable-schemas.mjs";
import { assistantIntentSchema } from "../dist/assistant-local-models.mjs";
import { watchdog } from "./watchdog.mjs";

const dir = mkdtempSync(join(tmpdir(), "tabai-tool-listing-"));
const stopWatchdog = watchdog(() => rmSync(dir, { recursive: true, force: true }));
const SAFE = Number.MAX_SAFE_INTEGER;

/** Every place in a JSON Schema where the listing differs from the contract, and every format it names. */
function inspect(schema, path, found = { problems: [], formats: new Set() }) {
  if (!schema || typeof schema !== "object") return found;
  const at = message => found.problems.push(`${path}: ${message}`);
  if ([schema.minimum, schema.maximum, schema.exclusiveMinimum, schema.exclusiveMaximum].some(bound => bound === SAFE || bound === -SAFE)) at("safe-integer bound");
  if ("propertyNames" in schema) at("propertyNames");
  if ("oneOf" in schema) at("oneOf");
  if (typeof schema.format === "string") found.formats.add(schema.format);
  if (schema.format === "email" && schema.pattern === z.regexes.email.source) at("zod's e-mail pattern");
  if (Array.isArray(schema.anyOf) && schema.anyOf.every(option => "const" in option)) at("literal union as branches");
  if (schema.type === "object" && Object.keys(schema.properties ?? {}).length && schema.additionalProperties !== false) at("open argument object");
  for (const [name, child] of Object.entries(schema.properties ?? {})) inspect(child, `${path}.${name}`, found);
  for (const key of ["anyOf", "oneOf", "allOf"]) for (const [index, child] of (schema[key] ?? []).entries()) inspect(child, `${path}.${key}[${index}]`, found);
  for (const key of ["items", "additionalProperties", "propertyNames", "not"]) if (schema[key] && typeof schema[key] === "object") inspect(schema[key], `${path}.${key}`, found);
  return found;
}
async function listed(server) {
  const client = new Client({ name: "tool-listing", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  try { return (await client.listTools()).tools; } finally { await client.close(); await server.close(); }
}

try {
  // The contract is not the library's default: one shape with every construct it changes, listed
  // as the SDK lists a raw shape, breaks each rule; the same shape through toolInputObject keeps
  // them, and keeps what an author wrote: a pattern, a description, a default and an enum.
  const shape = () => ({
    count: z.number().int().nonnegative(), size: z.number().int(), labels: z.record(z.string(), z.number()), mail: z.string().email(),
    kind: z.discriminatedUnion("kind", [z.object({ kind: z.literal("a") }).strict(), z.object({ kind: z.literal("b"), b: z.string() }).strict()]),
    hours: z.union([z.literal(1), z.literal(3)]), nested: z.object({ ref: z.string() }),
    ref: z.string().regex(/^ref_\d+$/), note: z.string().max(40).describe("A note"), offset: z.number().int().min(0).default(0),
    direction: z.enum(["up", "down"]), prefix: z.string().startsWith("tab_"),
  });
  const control = new McpServer({ name: "control", version: "1.0.0" });
  control.registerTool("raw", { inputSchema: shape() }, async () => ({ content: [] }));
  control.registerTool("listed", { inputSchema: toolInputObject(shape()) }, async () => ({ content: [] }));
  const [raw, closed] = await listed(control);
  const rawProblems = inspect(raw.inputSchema, "raw").problems.join("\n");
  for (const rule of ["safe-integer bound", "propertyNames", "oneOf", "zod's e-mail pattern", "literal union as branches", "open argument object"]) {
    assert.ok(rawProblems.includes(rule), `the library's own listing would show: ${rule}`);
  }
  assert.deepEqual(closed.inputSchema, {
    $schema: "http://json-schema.org/draft-07/schema#", type: "object", additionalProperties: false,
    required: ["count", "size", "labels", "mail", "kind", "hours", "nested", "ref", "note", "direction", "prefix"],
    properties: {
      count: { type: "integer", minimum: 0 }, size: { type: "integer" }, labels: { type: "object", additionalProperties: { type: "number" } },
      mail: { type: "string", format: "email" }, hours: { type: "number", enum: [1, 3] },
      kind: { anyOf: [{ type: "object", properties: { kind: { type: "string", const: "a" } }, required: ["kind"], additionalProperties: false },
        { type: "object", properties: { kind: { type: "string", const: "b" }, b: { type: "string" } }, required: ["kind", "b"], additionalProperties: false }] },
      nested: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"], additionalProperties: false },
      ref: { type: "string", pattern: "^ref_\\d+$" }, note: { type: "string", maxLength: 40, description: "A note" },
      offset: { type: "integer", minimum: 0, default: 0 }, direction: { type: "string", enum: ["up", "down"] },
      prefix: { type: "string", format: "starts_with", pattern: "^tab_.*" },
    },
  }, "toolInputObject lists the shape in the contract's form, with what its author wrote");
  let checked = 1;

  // The main catalog, in-process; no server process and no port.
  const bridge = { connected: true, pendingCount: 0, configurePanel() {}, activity: () => ({ calls: [] }), async call() { return { ok: true }; } };
  const server = new McpServer({ name: "tabai", version: "0.0.0" });
  registerCatalog(server, { bridge, recipes: new RecipeStore(join(dir, "recipes.json"), value => recipeSchema.parse(value)),
    history: new RunHistory(join(dir, "runs")), workflows: new WorkflowControl(), tempUploads: new Set(), serverVersion: EXTENSION_VERSION });
  const formats = new Set();
  const expectContract = (tools, label) => {
    for (const tool of tools) {
      const found = inspect(tool.inputSchema, `${label} ${tool.name}`);
      assert.deepEqual(found.problems, [], `${label} ${tool.name} keeps the listed contract`);
      for (const format of found.formats) formats.add(format);
      checked++;
    }
  };
  expectContract(await listed(server), "main");

  // The assistant worker in every mode the host starts it in; it dials its socket only for a call.
  for (const chat of [undefined, "1", "watch", "routine"]) for (const web of [undefined, "read", "act"]) for (const full of [undefined, "1"]) {
    const env = { TABAI_ASSISTANT_SOCKET: join(dir, "absent.sock"), TABAI_ASSISTANT_SECRET: "tool-listing",
      ...(chat ? { TABAI_ASSISTANT_CHAT: chat } : {}), ...(web ? { TABAI_ASSISTANT_WEB: web } : {}), ...(full ? { TABAI_ASSISTANT_FULL_ACCESS: full } : {}) };
    const worker = new Client({ name: "tool-listing-worker", version: "1.0.0" });
    await worker.connect(new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), "dist", "assistant-worker.mjs")], env, stderr: "ignore" }));
    let tools;
    try { tools = (await worker.listTools()).tools; } finally { await worker.close(); }
    const mode = `worker chat=${chat ?? "-"} web=${web ?? "-"} full=${full ?? "-"}`;
    expectContract(tools, mode);
    // The local model's grammar embeds each tool's listed arguments as they are.
    const intent = assistantIntentSchema(tools.map(tool => ({ name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema })));
    for (const branch of intent.oneOf.slice(1)) expectContract([{ name: branch.properties.tool.enum[0], inputSchema: branch.properties.arguments }], `${mode} intent`);
  }
  for (const format of ["uuid", "date-time", "email", "uri"]) assert.ok(formats.has(format), `${format} is still listed as a format`);
  console.log(`tool-listing: ${checked} listed argument schemas keep the contract, in both catalogs and every worker mode`);
} finally {
  rmSync(dir, { recursive: true, force: true });
  stopWatchdog();
}
