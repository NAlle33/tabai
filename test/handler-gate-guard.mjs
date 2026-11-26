// Static guard for the tab-ownership chokepoint. The handler set comes from
// executeTool's switch in background.ts and the imports that name each handler,
// so a new case, an arrow-function export or an `any` parameter cannot hide a
// handler. A handler must call assertTabInGroup(sessionOf(args), args.tabId), or
// pass a const bound to sessionOf(args), before its first tab access in source
// order. A tab access is a chrome.* call, a cdpSend or executeScript call, or any
// call handed args.tabId or the whole args object. A case only dispatches: tab
// work in the case itself fails. Source order is not control flow: a gate on one
// branch still counts for a later branch, so the live cross-session suites remain
// the runtime proof.
import assert from "node:assert/strict";
import ts from "typescript";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { watchdog } from "./watchdog.mjs";

const stopWatchdog = watchdog();
const BACKGROUND = "extension/src/background.ts";

// Dispatched code that addresses no tab. An entry fails the guard once it reads
// args.tabId or is no longer dispatched, so it cannot silently cover a new handler.
const EXEMPT_HANDLERS = new Set([
  "toolTabsContext", // reads or creates the calling session's own group
  "toolTabsCreate", // opens a new tab inside the calling session's own group
  "toolHealth", // read-only extension metadata for the calling session
]);
const EXEMPT_CASES = new Set([
  "extension_reload", // reloads the whole extension; inline, takes no arguments
]);

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const walk = (node, visit) => { visit(node); ts.forEachChild(node, child => walk(child, visit)); };
const contains = (node, predicate) => { let found = false; walk(node, n => { found ||= predicate(n); }); return found; };
const line = node => node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;
const rootOf = callee => {
  let e = callee;
  while (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isCallExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  return ts.isIdentifier(e) ? e.text : "";
};
const nameOf = callee => ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
// A Chrome API, CDP or script-injection call, whatever it is handed.
const isDirectTabCall = call => rootOf(call.expression) === "chrome" || ["cdpSend", "executeScript"].includes(nameOf(call.expression));
const readsTabId = (n, args) => ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === args && n.name.text === "tabId";

function findFunction(source, name, exportedOnly) {
  for (const statement of source.statements) {
    if (exportedOnly && !statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name && statement.body) return statement;
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
      let value = declaration.initializer;
      while (value && (ts.isParenthesizedExpression(value) || ts.isAsExpression(value) || ts.isSatisfiesExpression(value))) value = value.expression;
      if (value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value))) return value;
    }
  }
}

// Problems with one handler's gate, or none. `position` is the parameter that
// receives executeTool's args.
function gateProblems(fn, label, position) {
  const parameter = fn.parameters[position]?.name;
  if (!parameter || !ts.isIdentifier(parameter)) return [`${label} must take its tool arguments as one named parameter`];
  const args = parameter.text;
  const isArgs = n => ts.isIdentifier(n) && n.text === args;
  const isTabId = n => readsTabId(n, args);
  // The whole argument object, not one of its other fields or a declaration name.
  const isBareArgs = n => isArgs(n) && !(
    (ts.isPropertyAccessExpression(n.parent) && (n.parent.expression === n || n.parent.name === n))
    || (ts.isElementAccessExpression(n.parent) && n.parent.expression === n)
    || ((ts.isPropertyAssignment(n.parent) || ts.isParameter(n.parent) || ts.isVariableDeclaration(n.parent) || ts.isBindingElement(n.parent)) && n.parent.name === n));
  const isSessionOf = n => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "sessionOf"
    && n.arguments.length === 1 && isArgs(n.arguments[0]);
  const sessions = new Set();
  walk(fn.body, n => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && isSessionOf(n.initializer)
      && ts.isVariableDeclarationList(n.parent) && (n.parent.flags & ts.NodeFlags.Const)) sessions.add(n.name.text);
  });
  const isGate = n => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "assertTabInGroup"
    && n.arguments.length === 2 && isTabId(n.arguments[1])
    && (isSessionOf(n.arguments[0]) || (ts.isIdentifier(n.arguments[0]) && sessions.has(n.arguments[0].text)));
  const isTabAccess = call => !isSessionOf(call) && (isDirectTabCall(call)
    || call.arguments.some(arg => contains(arg, n => isTabId(n) || isBareArgs(n))));
  const gates = [];
  const accesses = [];
  walk(fn.body, n => {
    if (!ts.isCallExpression(n)) return;
    if (isGate(n)) gates.push(n);
    else if (isTabAccess(n)) accesses.push(n);
  });
  if (!gates.length) return [`${label} never calls assertTabInGroup(sessionOf(${args}), ${args}.tabId)`];
  const gateEnd = Math.min(...gates.map(gate => gate.getEnd()));
  const early = accesses.filter(call => call.getStart() < gateEnd).sort((a, b) => a.getStart() - b.getStart())[0];
  return early ? [`${label} reaches the tab through ${early.expression.getText()} (line ${line(early)}) before assertTabInGroup`] : [];
}

// Every dispatched handler, resolved through background.ts's imports.
// `overrides` replaces file contents, so the self-test can inject one defect.
function checkGates(overrides = {}) {
  const parse = path => ts.createSourceFile(path, overrides[path] ?? read(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const background = parse(BACKGROUND);
  const imports = new Map();
  for (const statement of background.statements) {
    const bindings = ts.isImportDeclaration(statement) && statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const module = posix.join(posix.dirname(BACKGROUND), `${statement.moduleSpecifier.text}.ts`);
    for (const element of bindings.elements) imports.set(element.name.text, { module, name: (element.propertyName ?? element.name).text });
  }
  const executeTool = findFunction(background, "executeTool", false);
  const argsName = executeTool?.parameters[1]?.name;
  assert.ok(executeTool && argsName && ts.isIdentifier(argsName), "background.ts must declare executeTool(tool, args)");
  const switches = [];
  walk(executeTool.body, n => { if (ts.isSwitchStatement(n)) switches.push(n); });
  assert.equal(switches.length, 1, "executeTool must dispatch through exactly one switch");
  const problems = [];
  const gated = new Set();
  const exempted = new Set();
  const cases = switches[0].caseBlock.clauses.filter(ts.isCaseClause);
  assert.ok(cases.length > 0, "executeTool's switch has no cases");
  for (const clause of cases) {
    const tool = ts.isStringLiteral(clause.expression) ? clause.expression.text : clause.expression.getText();
    const handlers = [];
    for (const statement of clause.statements) walk(statement, n => {
      const position = ts.isCallExpression(n) && ts.isIdentifier(n.expression)
        ? n.arguments.findIndex(a => ts.isIdentifier(a) && a.text === argsName.text) : -1;
      if (position >= 0) handlers.push({ handler: n.expression.text, position });
    });
    const usesArgs = clause.statements.some(statement => contains(statement, n => ts.isIdentifier(n) && n.text === argsName.text));
    if (EXEMPT_CASES.has(tool)) {
      exempted.add(tool);
      if (usesArgs) problems.push(`case "${tool}" is exempt but reads the tool arguments; dispatch it to a gated handler`);
      continue;
    }
    if (!handlers.length) { problems.push(`case "${tool}" passes ${argsName.text} to no handler the guard can check`); continue; }
    // The case only dispatches: tab work in the case itself would run ungated.
    const inline = [];
    for (const statement of clause.statements) walk(statement, n => {
      if ((ts.isCallExpression(n) && isDirectTabCall(n)) || readsTabId(n, argsName.text)) inline.push(n);
    });
    if (inline.length) problems.push(`case "${tool}" touches the tab itself through ${inline[0].getText()} (line ${line(inline[0])}); only a gated handler may`);
    for (const { handler, position } of handlers) {
      const origin = imports.get(handler);
      const fn = origin ? findFunction(parse(origin.module), origin.name, true) : findFunction(background, handler, false);
      const label = `${origin ? posix.basename(origin.module, ".ts") : "background"}.${handler} (case "${tool}")`;
      if (!fn) { problems.push(`${label} cannot be resolved to an exported function or arrow function`); continue; }
      if (EXEMPT_HANDLERS.has(handler)) {
        exempted.add(handler);
        const parameter = fn.parameters[position]?.name;
        if (parameter && ts.isIdentifier(parameter) && contains(fn.body, n => readsTabId(n, parameter.text))) {
          problems.push(`${label} is exempt but reads ${parameter.text}.tabId; gate it and remove the exemption`);
        }
        continue;
      }
      problems.push(...gateProblems(fn, label, position));
      gated.add(handler);
    }
  }
  for (const name of [...EXEMPT_HANDLERS, ...EXEMPT_CASES]) {
    if (!exempted.has(name)) problems.push(`the exemption for ${name} is stale: executeTool no longer dispatches it`);
  }
  return { problems, gated };
}

const { problems, gated } = checkGates();
assert.deepEqual(problems, [], `tab handlers without an ordered gate:\n  ${problems.join("\n  ")}`);
assert(gated.size >= 33, `guard must discover all tab handlers, found ${gated.size}`);
for (const name of ["toolReadPageCompact", "toolReadPageDiff"]) assert(gated.has(name), `${name} must be checked although its tabId comes from ReadArgs`);

// The guard itself must fail on each way a handler can escape it: the real tree
// plus one injected dispatch case and, where given, the handler it imports.
function withCase(caseSource, handler, code) {
  const module = "extension/src/cdp-tools.ts";
  const background = read(BACKGROUND);
  assert.ok(background.includes("switch (tool) {"), "self-test needs executeTool's switch");
  const dispatched = background.replace("switch (tool) {", `switch (tool) {\n    ${caseSource}`);
  return checkGates(handler ? {
    [module]: `${read(module)}\n${code}\n`,
    [BACKGROUND]: `import { ${handler} } from "./cdp-tools";\n${dispatched}`,
  } : { [BACKGROUND]: dispatched }).problems;
}
const withHandler = (tool, handler, code) => withCase(`case "${tool}": return ${handler}(args);`, handler, code);
const selfTests = [
  [withCase(`case "inline_tab": await chrome.tabs.get(args.tabId); return toolPrintToPdf(args);`),
    /case "inline_tab" touches the tab itself through chrome\.tabs\.get/],
  [withHandler("late_gate", "toolLateGate", "export async function toolLateGate(args: { tabId: number }) { await chrome.tabs.get(args.tabId); await assertTabInGroup(sessionOf(args), args.tabId); }"),
    /toolLateGate.*reaches the tab through chrome\.tabs\.get/],
  [withHandler("arrow_export", "toolArrowExport", "export const toolArrowExport = async (args: any) => cdpSend(args.tabId, \"Page.reload\");"),
    /toolArrowExport.*never calls assertTabInGroup/],
  [withHandler("ungated_case", "toolUngatedCase", "export async function toolUngatedCase(args: { tabId: number }) { return executeScript({ target: { tabId: args.tabId }, func: () => 1 }); }"),
    /toolUngatedCase.*never calls assertTabInGroup/],
  [withHandler("helper_first", "toolHelperFirst", "export async function toolHelperFirst(args: { tabId: number }) { const sessionId = sessionOf(args); await inject(sessionId, args.tabId, {}); await assertTabInGroup(sessionId, args.tabId); }"),
    /toolHelperFirst.*reaches the tab through inject/],
  [withHandler("foreign_session", "toolForeignSession", "export async function toolForeignSession(args: { tabId: number }) { await assertTabInGroup(\"default\", args.tabId); return chrome.tabs.get(args.tabId); }"),
    /toolForeignSession.*never calls assertTabInGroup/],
];
for (const [found, expected] of selfTests) {
  assert.equal(found.length, 1, `self-test must report exactly one problem: ${found.join("; ")}`);
  assert.match(found[0], expected);
}
console.log(`=== handler-gate-guard: ${gated.size} handlers gated before their first tab access, ${EXEMPT_HANDLERS.size + EXEMPT_CASES.size} exemptions, ${selfTests.length} injected defects refused ===`);
stopWatchdog();
