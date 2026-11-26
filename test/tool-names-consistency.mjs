// AST guard for the single catalog/schema wrapper and extension dispatcher.
import assert from "node:assert/strict";
import ts from "typescript";
import { readFileSync } from "node:fs";
import { EXTENSION_TOOLS } from "../dist/tool-names.mjs";
import { EXTENSION_VERSION, MIN_EXTENSION_VERSION } from "../dist/protocol.mjs";
import { watchdog } from "./watchdog.mjs";

const stopWatchdog = watchdog();
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const parse = (name, source = read(name)) => ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
function nodes(root, predicate) {
  const found = [];
  function visit(node) { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); }
  visit(root);
  return found;
}
const namedFunction = (root, name) => nodes(root, n => ts.isFunctionDeclaration(n) && n.name?.text === name);
const ORCHESTRATED = ["browser_batch", "upload_image", "recipe_save", "recipe_list", "recipe_run", "recipe_resume", "recipe_checkpoints", "recipe_record", "timeout_incidents", "run_history"];
const expected = [...EXTENSION_TOOLS, ...ORCHESTRATED].sort();

function checkCatalog(source) {
  const tree = parse("src/tool-catalog.ts", source);
  const registrations = nodes(tree, n => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "registerTool");
  const names = registrations.map(n => {
    assert.ok(ts.isStringLiteral(n.arguments[0]), "catalog tool name must be a string literal");
    return n.arguments[0].text;
  });
  assert.equal(new Set(names).size, names.length, "duplicate catalog registrations");
  assert.deepEqual(names.sort(), expected, "catalog must match dispatched and orchestrated tools");
  const sdk = nodes(tree, n => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "registerTool");
  assert.equal(sdk.length, 1, "exactly one SDK registration point");
  const [wrapper] = namedFunction(tree, "registerTool");
  assert.ok(wrapper, "schema-recording wrapper exists");
  assert.ok(sdk[0].pos >= wrapper.pos && sdk[0].end <= wrapper.end, "SDK registration belongs to the wrapper");
  const schemaWrites = nodes(wrapper, n => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
    && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === "TOOL_SCHEMAS" && n.expression.name.text === "set");
  assert.equal(schemaWrites.length, 1, "wrapper records each schema");
  assert.ok(schemaWrites[0].pos < sdk[0].pos, "record the schema before SDK registration");
}

const background = parse("extension/src/background.ts");
const dispatchers = namedFunction(background, "executeTool");
assert.equal(dispatchers.length, 1, "exactly one extension dispatcher");
const switches = nodes(dispatchers[0], n => ts.isSwitchStatement(n) && ts.isIdentifier(n.expression) && n.expression.text === "tool");
assert.equal(switches.length, 1);
const cases = switches[0].caseBlock.clauses.filter(ts.isCaseClause).map(n => {
  assert.ok(ts.isStringLiteral(n.expression));
  return n.expression.text;
});
assert.equal(new Set(cases).size, cases.length, "duplicate dispatcher cases");
assert.deepEqual(cases.sort(), [...EXTENSION_TOOLS].sort());

const catalog = read("src/tool-catalog.ts");
checkCatalog(catalog);
assert.throws(() => checkCatalog(catalog.replace('"tabs_context_mcp",', '"missing_tool",')));
assert.throws(() => checkCatalog(catalog + '\nregisterTool("health", {}, () => {});'));
assert.throws(() => checkCatalog(catalog + '\nserver.registerTool("bypass", {}, () => {});'));
assert.doesNotThrow(() => checkCatalog(catalog.replaceAll("registerTool(\n", "registerTool( /* formatting */\n")));

const bootstrap = parse("src/server.ts");
assert.equal(nodes(bootstrap, n => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "registerTool").length, 0,
  "bootstrap must not bypass the catalog");
const versions = nodes(bootstrap, n => ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === "SERVER_VERSION");
assert.equal(versions.length, 1);
assert.ok(ts.isStringLiteral(versions[0].initializer));
const packageVersion = JSON.parse(read("package.json")).version;
const manifestVersion = JSON.parse(read("extension/manifest.json")).version;
for (const version of [manifestVersion, EXTENSION_VERSION, MIN_EXTENSION_VERSION, versions[0].initializer.text]) assert.equal(version, packageVersion);
stopWatchdog();
console.log(`tool-names-consistency: ${expected.length} catalog tools, ${cases.length} dispatched, one schema wrapper, versions and negative guards PASS`);
