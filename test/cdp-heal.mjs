import assert from "node:assert/strict";
import { Script } from "node:vm";
import { watchdog } from "./watchdog.mjs";

const stopWatchdog = watchdog();
let attaches = 0;
let sends = 0;
let mode = "once";
let attachmentError;
let attachDelayMs = 0;
let attachHook;
let compileHook;
let compilationCommands = [];
// The page-evaluation section installs its own command behaviour here; while it
// is unset the original mode-driven stub answers.
let commandHook;
globalThis.chrome = {
  runtime: {}, tabs: { onRemoved: { addListener() {} } },
  debugger: {
    onDetach: { addListener() {} }, onEvent: { addListener() {} },
    attach: (_target, _version, callback) => {
      attaches++;
      const settle = () => {
        attachHook?.();
        if (attachmentError) chrome.runtime.lastError = { message: attachmentError };
        try { callback(); } finally { delete chrome.runtime.lastError; }
      };
      if (attachDelayMs) setTimeout(settle, attachDelayMs);
      else settle();
    },
    sendCommand: async (_target, method, params) => {
      if (method === "Runtime.enable" || method === "Runtime.compileScript") {
        compilationCommands.push({ method, params });
        if (compileHook) return compileHook(method, params);
        if (method === "Runtime.compileScript") {
          // Parse only, in V8 Script grammar. The source is never run here.
          try { new Script(params.expression); }
          catch (error) {
            return { exceptionDetails: { exception: { className: error.name, description: String(error) } } };
          }
        }
        return {};
      }
      sends++;
      if (commandHook) return commandHook(method, params);
      if (mode === "always" || (mode === "once" && sends === 1)) throw new Error("Debugger is not attached");
      if (mode === "generic") throw new Error("Command may have completed");
      return { value: 42 };
    },
  },
};
const { cdpSend, attachedTabIds } = await import("../dist/cdp.mjs");
assert.deepEqual(await cdpSend(1, "Runtime.evaluate", {}), { value: 42 });
assert.equal(attaches, 2); assert.equal(sends, 2);
console.log("  ✓ stale attachment is healed and the command retried once");
mode = "always"; sends = 0;
await assert.rejects(cdpSend(1, "Runtime.evaluate", {}), /not attached/);
assert.equal(sends, 2);
console.log("  ✓ second attachment failure propagates");
mode = "generic"; sends = 0;
await assert.rejects(cdpSend(1, "Input.insertText", {}), /may have completed/);
assert.equal(sends, 1);
console.log("  ✓ ambiguous command failure is never replayed");
// Arbitrary user JavaScript reaches the page through Runtime.evaluate. A generic
// failure there may follow a completed mutation, so it must never be resent.
mode = "generic"; sends = 0;
await assert.rejects(cdpSend(1, "Runtime.evaluate", { expression: "1" }), /may have completed/);
assert.equal(sends, 1);
console.log("  ✓ ambiguous Runtime.evaluate failure is never replayed");

// Chrome reports this for both a surviving attachment owned by the extension
// and a foreign debugger. Only a successful command proves usable ownership.
attachmentError = "Another debugger is already attached to the tab with id: 2.";
mode = "success"; attaches = 0; sends = 0;
assert.deepEqual(await cdpSend(2, "Runtime.evaluate", {}), { value: 42 });
assert.deepEqual(await cdpSend(2, "Runtime.evaluate", {}), { value: 42 });
assert.equal(attaches, 1);
assert.equal(sends, 2);
assert(attachedTabIds().includes(2));
console.log("  ✓ a working attachment from an earlier worker remains usable and cached");

attachmentError = "Another debugger is already attached to the tab with id: 3.";
mode = "always"; attaches = 0; sends = 0;
await assert.rejects(cdpSend(3, "Input.insertText", { text: "once" }), /Close DevTools or the other debugger/);
assert.equal(attaches, 2);
assert.equal(sends, 2, "only one retry is safe after a not-attached rejection");
assert(!attachedTabIds().includes(3), "foreign ownership must not remain in the attachment cache");
console.log("  ✓ foreign debugger ownership fails with an actionable hint and clears the cache");

attachmentError = undefined;
mode = "success"; attaches = 0; sends = 0;
assert.deepEqual(await cdpSend(3, "Input.insertText", { text: "once" }), { value: 42 });
assert.equal(attaches, 1, "closing the foreign debugger must allow a fresh attachment");
assert.equal(sends, 1);
console.log("  ✓ closing the foreign debugger permits a fresh attachment on the next call");

// ---- page evaluation: envelopes, dispatch deadlines, and the wait loop ------
// The same Chrome stub, extended with the ownership, scripting and tab surfaces
// the evaluator uses. `commandHook` can EXECUTE the generated expression in this
// process, so serialization, JSON argument encoding and the real in-page
// predicate classification are exercised without a browser.
const SESSION = "sess-1234";
const OWNED_GROUP = 500;
let tabState = { status: "complete", groupId: OWNED_GROUP, url: "https://example.test/" };
let tabsGetDelayMs = 0;
let documentIds = [];
let injections = [];
let injectionHook;
let tabsGetHook;
// A null entry stands for a document the browser would not identify.
const nextDocumentId = () => (documentIds.length > 1 ? documentIds.shift() : documentIds[0]);
Object.assign(chrome, {
  storage: { local: { async get() { return { mcpGroups: { [SESSION]: OWNED_GROUP } }; }, async set() {} } },
  tabGroups: { async get(id) { if (id !== OWNED_GROUP) throw new Error("no group"); return { id, title: `MCP·${SESSION.slice(0, 4)}` }; } },
  scripting: {
    async executeScript(injection) {
      injections.push(injection);
      injectionHook?.();
      // An Error entry stands for a probe the browser rejects, as it does while
      // a cross-document commit is in flight.
      const next = nextDocumentId();
      if (next instanceof Error) throw next;
      return [{ documentId: next, result: null }];
    },
  },
});
chrome.tabs.get = async (tabId) => {
  if (tabsGetDelayMs) await new Promise(resolve => setTimeout(resolve, tabsGetDelayMs));
  tabsGetHook?.();
  return { id: tabId, ...tabState };
};
chrome.tabs.query = async () => [];

const { evaluateInPage } = await import("../dist/page-evaluation.mjs");
const { waitInTab } = await import("../dist/page-wait.mjs");

const echoInPage = (kind, value) => ({ ok: false, kind, echoed: value });
const expired = () => new Error("request expired");
function request(overrides = {}) {
  return {
    sessionId: SESSION,
    tabId: 10,
    deadline: Date.now() + 5000,
    expired,
    func: echoInPage,
    args: ["predicate", "true"],
    awaitPromise: false,
    ...overrides,
  };
}
function reset({ hook, tabId = 10, doc = ["doc-stable"], status = "complete", group = OWNED_GROUP } = {}) {
  sends = 0; attaches = 0; attachDelayMs = 0; tabsGetDelayMs = 0;
  attachHook = undefined; injectionHook = undefined; tabsGetHook = undefined;
  compileHook = undefined; compilationCommands = [];
  injections = []; documentIds = [...doc];
  tabState = { status, groupId: group, url: "https://example.test/" };
  commandHook = hook;
  return tabId;
}
// Runs the generated expression here, so a passing assertion proves the real
// serialized function and its JSON-encoded arguments round-trip.
const runExpression = (_method, params) => ({ result: { type: "object", value: eval(params.expression) } });

let evaluateParams;
reset({ hook: (method, params) => { evaluateParams = { method, params }; return runExpression(method, params); } });
const tricky = 'a"b\\c\nd e';
const echoed = await evaluateInPage(request({ args: ["predicate", tricky] }));
assert.equal(echoed.status, "ok");
assert.deepEqual(echoed.value, { ok: false, kind: "predicate", echoed: tricky });
assert.equal(evaluateParams.method, "Runtime.evaluate");
assert.equal(evaluateParams.params.returnByValue, true);
assert.equal(evaluateParams.params.awaitPromise, false);
assert.equal(evaluateParams.params.allowUnsafeEvalBlockedByCSP, true);
assert.equal(evaluateParams.params.userGesture, false);
assert.equal(evaluateParams.params.includeCommandLineAPI, false);
assert.ok(evaluateParams.params.timeout > 0 && evaluateParams.params.timeout <= 5000, "CDP timeout must come from the remaining budget");
assert.equal(injections.length, 2, "one identity probe before and one after the evaluation");
for (const injection of injections) {
  assert.equal(injection.world, "MAIN");
  assert.equal(injection.injectImmediately, true, "a deferred probe would wait for a slow subresource");
  assert.equal(injection.target.tabId, 10);
}
console.log("  ✓ explicit evaluation options, JSON-encoded arguments and immediate identity probes");

reset({ hook: () => ({ result: { type: "object", value: { ok: false, kind: "predicate" } } }) });
assert.deepEqual((await evaluateInPage(request())).value, { ok: false, kind: "predicate" });
reset({ hook: () => ({ result: { type: "object", value: { ok: true, value: null } } }) });
assert.deepEqual((await evaluateInPage(request({ awaitPromise: true }))).value, { ok: true, value: null });
console.log("  ✓ a false result and a null value are accepted, not mistaken for a missing envelope");

reset({ hook: () => ({ exceptionDetails: { text: "Uncaught", exception: { description: "EvalError: refused by policy" } } }) });
await assert.rejects(evaluateInPage(request()), /page evaluation failed: EvalError: refused by policy/);
for (const [label, response] of [
  ["no response", undefined],
  ["no result", {}],
  ["undefined result", { result: { type: "undefined" } }],
  ["primitive result", { result: { type: "boolean", value: false } }],
  ["null result", { result: { type: "object", value: null } }],
]) {
  reset({ hook: () => response });
  await assert.rejects(evaluateInPage(request()), /no evaluation result|unusable evaluation envelope/, label);
}
console.log("  ✓ thrown, missing and malformed envelopes fail instead of reporting success");

reset({ hook: runExpression, doc: ["doc-before", "doc-after"] });
assert.deepEqual(await evaluateInPage(request()), { status: "document-changed" });
reset({ hook: runExpression, doc: ["doc-first", null] });
await assert.rejects(evaluateInPage(request()), /could not be identified/);
console.log("  ✓ a replaced or unverifiable document never certifies a completed evaluation");

// A probe rejected mid-commit is the same failure the wait loop has always
// retried. One retry decides it; only a second failure is terminal.
const commitInFlight = () => new Error("Frame with ID 0 was removed.");
reset({ hook: runExpression, doc: ["doc-old", commitInFlight(), "doc-new"] });
assert.deepEqual(await evaluateInPage(request()), { status: "document-changed" });
reset({ hook: runExpression, doc: ["doc-same", commitInFlight(), "doc-same"] });
const survived = await evaluateInPage(request());
assert.equal(survived.status, "ok", "an unchanged document must still accept its result");
assert.equal(survived.documentId, "doc-same");
reset({ hook: runExpression, doc: ["doc-old", commitInFlight(), commitInFlight()] });
await assert.rejects(evaluateInPage(request()), /could not identify the page's document/);
console.log("  ✓ a probe rejected during a commit retries once, and twice is terminal");

reset({ hook: runExpression, doc: ["doc-old", commitInFlight(), "doc-new"] });
assert.deepEqual(await waitInTab(SESSION, 23, "predicate", "true", 3000), { ok: true, kind: "predicate" });
assert.equal(sends, 2, "the wait must re-poll in the replacement document, not fail");
console.log("  ✓ a wait survives a document commit that rejects its identity probe");

reset({ hook: runExpression });
tabsGetDelayMs = 150;
await assert.rejects(evaluateInPage(request({ deadline: Date.now() + 40 })), /request expired/);
assert.equal(sends, 0, "a delayed ownership gate must not buy the evaluation a fresh budget");
// A tab this module has never attached to, so the slow attachment really runs.
reset({ hook: runExpression });
attachDelayMs = 150;
await assert.rejects(evaluateInPage(request({ tabId: 21, deadline: Date.now() + 40 })), /request expired/);
assert.equal(sends, 0, "an attachment that outlives the deadline must dispatch nothing");
console.log("  ✓ a delayed ownership gate or attachment dispatches no command");

reset({ hook: () => { throw new Error("Debugger is not attached"); } });
await assert.rejects(
  evaluateInPage(request({ isStopped: () => sends >= 1 })),
  /request expired/,
);
assert.equal(sends, 1, "the one safe resend must not run for an abandoned request");
reset({ hook: () => { throw new Error("Debugger is not attached"); } });
let ownershipChecks = 0;
chrome.tabs.get = async (tabId) => {
  // The tab leaves its group while the safe recovery attaches again.
  if (++ownershipChecks > 2) return { id: tabId, ...tabState, groupId: OWNED_GROUP + 1 };
  return { id: tabId, ...tabState };
};
await assert.rejects(evaluateInPage(request()), /not in your session's MCP tab group/);
assert.equal(sends, 1, "a tab that left its group must not receive a resent evaluation");
chrome.tabs.get = async (tabId) => {
  if (tabsGetDelayMs) await new Promise(resolve => setTimeout(resolve, tabsGetDelayMs));
  tabsGetHook?.();
  return { id: tabId, ...tabState };
};
console.log("  ✓ an expired request or a moved tab never receives the one safe resend");

reset({ hook: () => { throw new Error("Command may have completed"); } });
await assert.rejects(evaluateInPage(request()), /may have completed/);
assert.equal(sends, 1);
assert.equal(injections.length, 1, "an ambiguous failure must not run another evaluator");
console.log("  ✓ an ambiguous evaluation failure is reported once, with no second evaluator");

// ---- the wait loop around that evaluator -----------------------------------
reset({ hook: () => { throw new Error("Command may have completed"); }, status: "loading" });
await assert.rejects(waitInTab(SESSION, 11, "predicate", "true", 3000), /may have completed/);
assert.equal(sends, 1, "a loading tab must not turn an ambiguous evaluation failure into another poll");
console.log("  ✓ a terminal evaluator failure ends the wait even while the tab is loading");

reset({ hook: runExpression, doc: ["doc-old", "doc-new"] });
assert.deepEqual(await waitInTab(SESSION, 12, "predicate", "true", 3000), { ok: true, kind: "predicate" });
assert.equal(sends, 2, "a replaced document must be re-probed, not accepted and not abandoned");
console.log("  ✓ a changed document discards the completed result and the next poll succeeds");

reset({ hook: runExpression, doc: [null] });
await assert.rejects(waitInTab(SESSION, 13, "predicate", "true", 1500), /could not be identified/);
assert.equal(sends, 0, "an unverifiable document must not dispatch the predicate");
console.log("  ✓ an unverifiable document fails the wait before the predicate runs");

reset({ hook: runExpression });
assert.deepEqual(await waitInTab(SESSION, 14, "predicate", "Promise.resolve(false)", 2000), { ok: true, kind: "predicate" });
console.log("  ✓ a Promise object stays synchronously truthy through the evaluator");

reset({ hook: runExpression });
await assert.rejects(waitInTab(SESSION, 15, "predicate", "(", 4000), /syntax error/);
reset({ hook: runExpression });
await assert.rejects(
  waitInTab(SESSION, 16, "predicate", "(()=>{throw new EvalError('Refused to evaluate a string as JavaScript because it violates the following Content Security Policy directive')})()", 4000),
  /refused to evaluate the predicate/i,
);
console.log("  ✓ syntax and policy refusals fail promptly instead of timing out silently");

// A SyntaxError raised while RUNNING is ordinary: the element the predicate
// parses has not been filled in yet. Only a predicate that cannot compile is
// permanently unusable.
reset({ hook: runExpression });
await assert.rejects(
  waitInTab(SESSION, 22, "predicate", "JSON.parse('').ready === true", 700),
  /timed out after 700ms \(last predicate error: SyntaxError/,
);
console.log("  ✓ a runtime SyntaxError keeps polling instead of failing permanently");

reset({ hook: runExpression });
let started = Date.now();
await assert.rejects(
  waitInTab(SESSION, 17, "predicate", "missingGlobalUnderTest.ready", 700),
  /timed out after 700ms \(last predicate error: ReferenceError/,
);
assert.ok(Date.now() - started >= 600, "a retryable predicate error must keep polling to the deadline");
reset({ hook: runExpression });
await assert.rejects(waitInTab(SESSION, 18, "predicate", "false", 500), /timed out after 500ms(?: |$)/);
console.log("  ✓ retryable errors keep polling and reach the timeout with their last reason");

reset({ hook: runExpression });
await assert.rejects(waitInTab(SESSION, 19, "predicate", "false", 400), /timed out after 400ms/);
const afterTimeout = sends;
await new Promise(resolve => setTimeout(resolve, 400));
assert.equal(sends, afterTimeout, "an expired wait must not schedule another probe");
commandHook = undefined;
console.log("  ✓ an expired wait starts no further poll");

// A fake epoch clock makes the dispatch budget assertions exact; no renderer
// ever runs caller code for these transport-boundary tests.
const regressionFailures = [];
async function regression(name, check) {
  try {
    await check();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    regressionFailures.push(`${name}: ${error.message}`);
  }
}
for (const [index, delayAt] of ["attachment", "ownership", "reattachment"].entries()) {
  await regression(`dispatch budget includes delayed ${delayAt}`, async () => {
    const realNow = Date.now;
    let now = 0;
    let ownershipReads = 0;
    const samples = [];
    reset({ hook: (method, params) => {
      samples.push({ timeout: params.timeout, remaining: 1000 - now });
      if (delayAt === "reattachment" && sends === 1) throw new Error("Debugger is not attached");
      return runExpression(method, params);
    } });
    attachHook = () => {
      if (delayAt === "attachment" || (delayAt === "reattachment" && attaches === 2)) now = 900;
    };
    tabsGetHook = () => {
      if (++ownershipReads === 2 && delayAt === "ownership") now = 900;
    };
    Date.now = () => now;
    try {
      assert.equal((await evaluateInPage(request({ tabId: 30 + index, deadline: 1000 }))).status, "ok");
      assert.equal(samples.length, delayAt === "reattachment" ? 2 : 1);
      for (const sample of samples) assert.equal(sample.timeout, sample.remaining, JSON.stringify(samples));
    } finally {
      Date.now = realNow;
      reset();
    }
  });
}

for (const boundary of ["stopped", "expired", "moved"]) {
  await regression(`a ${boundary} evaluation starts no post-evaluation identity probe`, async () => {
    const realNow = Date.now;
    let now = 0;
    let stopped = false;
    reset({ hook: (method, params) => {
      if (boundary === "stopped") stopped = true;
      if (boundary === "expired") now = 1001;
      if (boundary === "moved") tabState.groupId++;
      return runExpression(method, params);
    } });
    Date.now = () => now;
    try {
      await assert.rejects(evaluateInPage(request({ deadline: 1000, isStopped: () => stopped })),
        boundary === "moved" ? /not in your session's MCP tab group/ : /request expired/);
      assert.equal(injections.length, 1, "only the pre-evaluation identity probe may run");
    } finally {
      Date.now = realNow;
      reset();
    }
  });
}

for (const boundary of ["expired", "moved"]) {
  await regression(`identity retry checks whether the request ${boundary}`, async () => {
    const realNow = Date.now;
    let now = 0;
    reset({ hook: runExpression, doc: ["doc-before", commitInFlight(), "doc-after"] });
    injectionHook = () => {
      if (injections.length === 2) {
        if (boundary === "expired") now = 1001;
        else tabState.groupId++;
      }
    };
    Date.now = () => now;
    try {
      await assert.rejects(evaluateInPage(request({ deadline: 1000 })),
        boundary === "moved" ? /not in your session's MCP tab group/ : /request expired/);
      assert.equal(injections.length, 2, "the failed identity probe must not be retried after losing authority");
    } finally {
      Date.now = realNow;
      reset();
    }
  });
}

await regression("a genuinely late true response starts no identity probe and cannot satisfy a wait", async () => {
  let release;
  reset({ hook: () => new Promise(resolve => { release = resolve; }) });
  await assert.rejects(waitInTab(SESSION, 40, "predicate", "true", 80), /timed out after 80ms/);
  assert.equal(typeof release, "function", "the predicate must have been dispatched before timeout");
  assert.equal(sends, 1);
  release({ result: { type: "object", value: { ok: true, kind: "predicate" } } });
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(sends, 1, "the late value must not cause another evaluation");
  assert.equal(injections.length, 1, "the late value must not start an identity probe");
});

for (const predicate of ["return true", "new.target"]) {
  await regression(`Script syntax fails promptly: ${predicate}`, async () => {
    reset({ hook: runExpression });
    await assert.rejects(waitInTab(SESSION, 41, "predicate", predicate, 150), /predicate has a syntax error/);
    assert.equal(sends, 0, "a malformed predicate must be rejected without execution");
  });
}
await regression("a Script hashbang remains a valid truthy predicate", async () => {
  reset({ hook: runExpression });
  assert.deepEqual(await waitInTab(SESSION, 42, "predicate", "#! predicate\ntrue", 500), { ok: true, kind: "predicate" });
  assert.equal(sends, 1);
});

await regression("predicate compilation runs once, stores no script and executes no caller code", async () => {
  reset({ hook: runExpression });
  globalThis.predicateCompileCounter = 0;
  try {
    assert.deepEqual(await waitInTab(SESSION, 43, "predicate", "++globalThis.predicateCompileCounter === 2", 1500),
      { ok: true, kind: "predicate" });
    assert.equal(globalThis.predicateCompileCounter, 2);
    assert.equal(sends, 2, "only the two ordinary polls may execute the predicate");
    assert.deepEqual(compilationCommands, [
      { method: "Runtime.enable", params: {} },
      { method: "Runtime.compileScript", params: {
        expression: "++globalThis.predicateCompileCounter === 2", sourceURL: "", persistScript: false,
      } },
    ]);
  } finally {
    delete globalThis.predicateCompileCounter;
  }
});

await regression("safe compilation recovery enables Runtime on the replacement attachment", async () => {
  reset({ hook: runExpression });
  let compilations = 0;
  compileHook = (method) => {
    if (method === "Runtime.compileScript" && ++compilations === 1) throw new Error("Debugger is not attached");
    return {};
  };
  assert.equal((await waitInTab(SESSION, 44, "predicate", "true", 1500)).ok, true);
  assert.deepEqual(compilationCommands.map(({ method }) => method), [
    "Runtime.enable", "Runtime.compileScript", "Runtime.enable", "Runtime.compileScript",
  ]);
  assert.equal(sends, 1, "setup recovery must not execute the predicate twice");
});

for (const boundary of ["expired", "moved"]) {
  await regression(`a ${boundary} compilation starts no predicate or identity probe`, async () => {
    let release;
    reset({ hook: runExpression });
    compileHook = method => method === "Runtime.enable" ? {} : new Promise(resolve => { release = resolve; });
    const pending = waitInTab(SESSION, 45, "predicate", "true", 100);
    // Wait until compilation is in flight, then settle it across the boundary.
    while (!release) await new Promise(resolve => setImmediate(resolve));
    if (boundary === "expired") {
      await assert.rejects(pending, /timed out after 100ms/);
      release({});
    } else {
      tabState.groupId++;
      release({});
      await assert.rejects(pending, /not in your session's MCP tab group/);
    }
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(sends, 0);
    assert.equal(injections.length, 0);
  });
}
assert.deepEqual(regressionFailures, [], regressionFailures.join("\n"));

console.log("=== cdp-heal: PASS ===");
stopWatchdog();
