import { createMcpClient, createMcpTransport, connectMcpClient, callRaw } from "./helpers/mcp-client.mjs";
// Real extension regressions: history entries without user activation, pending
// waits whose original document is replaced, and page evaluation under a strict
// HTTP Content-Security-Policy. Run via test:ci, or directly after building and
// reloading the everyday Chrome extension.
import assert from "node:assert/strict";
import http from "node:http";
import { env as runtimeEnvironment } from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";


import { watchdog } from "./watchdog.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const client = createMcpClient({ name: "navigation-live", version: "0.0.0" });
const tabs = new Set();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const responseTimers = new Set();

// A real response-header policy WITHOUT 'unsafe-eval'. The page's own script has
// to be external and same-origin, which 'self' allows and inline script does not.
const STRICT_CSP = "default-src 'self'; script-src 'self'; object-src 'none'";
// Runs in the page under that policy: records whether the PAGE's own string
// evaluation is refused, and whether a back/forward entry was restored from the
// back-forward cache. The eval check repeats on a page-owned timer, so it always
// samples the page's ordinary privileges — a tool's ref click would not, because
// it runs the handler inside a CDP evaluation that carries its own CSP allowance.
const CSP_PROBE_SCRIPT = `
function cspRunPageEval() {
  var status;
  try { status = "page-eval-ran:" + (0, eval)("1+1"); }
  catch (error) { status = "page-eval-blocked"; }
  var el = document.getElementById("evalstatus");
  if (el) el.textContent = status;
}
window.addEventListener("pageshow", function (event) {
  var el = document.getElementById("persisted");
  if (el) el.textContent = event.persisted ? "restored-from-bfcache" : "freshly-loaded";
});
cspRunPageEval();
setInterval(cspRunPageEval, 200);
`;
const cspPage = (title, scriptQuery = "") =>
  `<h1 id="csp-marker">strict-csp-marker</h1>` +
  `<div id="evalstatus">page-eval-untested</div>` +
  `<div id="persisted">freshly-loaded</div>` +
  `<p>${title}</p>` +
  `<script src="/csp-probe.js${scriptQuery}"></script>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const delayMs = Math.min(2000, Number(url.searchParams.get("delay")) || 0);
  const respond = (headers, payload) => {
    const timer = setTimeout(() => {
      responseTimers.delete(timer);
      res.writeHead(200, headers);
      res.end(payload);
    }, delayMs);
    responseTimers.add(timer);
  };
  if (url.pathname === "/csp-probe.js") {
    respond({ "Content-Type": "text/javascript", "Cache-Control": "no-store" }, CSP_PROBE_SCRIPT);
    return;
  }
  // Only the evaluation fixtures carry the policy: the older navigation routes
  // must keep failing or passing for their own reasons, not for a CSP reason.
  const strict = url.pathname === "/csp" || url.pathname.startsWith("/bfcache");
  const html = payload =>
    respond(
      {
        "Content-Type": "text/html",
        ...(strict ? { "Content-Security-Policy": STRICT_CSP } : {}),
        // The back-forward cache declines a no-store document, so the two
        // bfcache routes are the only ones that may omit it.
        ...(url.pathname.startsWith("/bfcache") ? {} : { "Cache-Control": "no-store" }),
      },
      `<!doctype html><title>Navigation regression</title>${payload}`,
    );
  if (url.pathname === "/csp") {
    // ?slow=N keeps the parser blocked on the external script for N ms, so the
    // document is observable while the tab still reports "loading".
    const slow = Math.min(2000, Number(url.searchParams.get("slow")) || 0);
    html(cspPage("strict csp", slow ? `?delay=${slow}` : ""));
    return;
  }
  if (url.pathname === "/bfcache-a" || url.pathname === "/bfcache-b") {
    html(cspPage(url.pathname === "/bfcache-a" ? "bfcache entry A" : "bfcache entry B"));
    return;
  }
  if (url.pathname === "/report") {
    html(`<h1>Report fixture</h1>
      <label>Report setting <input id="report-setting" type="number" value="1"></label>
      <output id="report-result">42</output>
      <div id="report-generation" data-generation="0" data-busy="false"></div>
      <script>
        const setting = document.getElementById('report-setting');
        const marker = document.getElementById('report-generation');
        let requestedGeneration = 0;
        setting.addEventListener('change', () => {
          const generation = ++requestedGeneration;
          marker.dataset.busy = 'true';
          setTimeout(() => {
            if (generation !== requestedGeneration) return;
            document.getElementById('report-result').textContent = '42';
            marker.dataset.generation = String(generation);
            marker.dataset.busy = 'false';
          }, 600);
        });
        window.requestFixtureReport = value => {
          setting.value = String(value);
          setting.dispatchEvent(new Event('input', {bubbles:true}));
          setting.dispatchEvent(new Event('change', {bubbles:true}));
        };
      </script>`);
    return;
  }
  html(
    url.pathname === "/end"
      ? '<h1 id="arrived">navigation-complete-marker</h1>'
      : url.pathname === "/middle"
        ? '<h1>Middle</h1><a href="/end">Open end</a>'
        : '<h1>Start</h1><a href="/middle">Open middle</a>',
  );
});

async function call(name, args = {}) {
  const result = await callRaw(client, { name, arguments: args });
  return { isError: result.isError === true, text: result.content?.[0]?.text ?? "" };
}
async function ok(name, args) {
  const result = await call(name, args);
  assert.equal(result.isError, false, result.text);
  return result.text;
}
function waitDiagnostics(text) {
  const marker = "waitDiagnostics=";
  const start = text.lastIndexOf(marker);
  assert.ok(start >= 0, `missing wait observations: ${text}`);
  return JSON.parse(text.slice(start + marker.length, text.lastIndexOf("}") + 1));
}
async function createTab() {
  const tab = JSON.parse(await ok("tabs_create_mcp", {})).tabId;
  assert.equal(typeof tab, "number");
  tabs.add(tab);
  return tab;
}
async function cleanup() {
  for (const tabId of tabs) await call("tabs_close_mcp", { tabId }).catch(() => {});
  tabs.clear();
  await client.close();
  for (const timer of responseTimers) clearTimeout(timer);
  responseTimers.clear();
  server.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}
const stopWatchdog = watchdog(cleanup);
let failures = 0;
let passes = 0;
// Chrome declines the back-forward cache for many reasons, including an attached
// debugger. Report what actually happened instead of implying restoration.
let bfcacheObservation = "not observed";
async function test(name, run) {
  try {
    await run();
    passes++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}: ${error.message}`);
    // Preserve metadata while the failing worker is still alive; teardown loses
    // the pending Chrome stage. Never log page arguments or evaluation source.
    try {
      const health = JSON.parse(await ok("health", {}));
      console.error("    failure diagnostics:", JSON.stringify({ serverBuildId: health.serverBuildId,
        extensionBuildId: health.extension?.buildId, operations: health.extension?.diagnostics }));
    } catch (inspectionError) { console.error("    failure diagnostics unavailable:", inspectionError.message); }
  }
}

try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await connectMcpClient(client, createMcpTransport({
    command: process.execPath,
    args: [join(root, "dist", "server.js")],
    cwd: root,
    // Forward only this project's runtime settings; the SDK supplies its
    // standard subprocess environment without copying unrelated credentials.
    env: Object.fromEntries(Object.entries(runtimeEnvironment).filter(
      ([name, value]) => name.startsWith("CCMCP_") && typeof value === "string",
    )),
  }));
  await ok("tabs_context_mcp", {});
  const tabId = await createTab();
  const navigate = path => ok("navigate", { tabId, url: origin + path, waitUntil: "load" });
  const evaluate = text => ok("javascript_tool", { tabId, text });
  const scheduleNavigation = async (path = "/end?delay=300") => {
    await evaluate(`(()=>{setTimeout(()=>location.assign(${JSON.stringify(origin + path)}),300);return 'scheduled once'})()`);
  };

  await test("back and forward reach adjacent entries after a tool click", async () => {
    await navigate("/start");
    const found = await ok("find", { tabId, query: "Open middle" });
    const ref = found.match(/\[(ref_\d+)\]/)?.[1];
    assert.ok(ref, found);
    await ok("computer", { tabId, action: "left_click", ref });
    await ok("wait_for", { tabId, predicate: "location.pathname === '/middle'", timeoutMs: 2000 });
    assert.match(await evaluate("navigator.userActivation.hasBeenActive"), /false/);
    const back = JSON.parse(await ok("navigate", { tabId, url: "back", waitUntil: "load" }));
    assert.equal(new URL(back.url).pathname, "/start");
    const forward = JSON.parse(await ok("navigate", { tabId, url: "forward", waitUntil: "load" }));
    assert.equal(new URL(forward.url).pathname, "/middle");
  });

  await test("back and forward traverse same-document entries without a load timeout", async () => {
    await navigate("/start");
    await evaluate("(()=>{history.pushState({},'', '#one');history.pushState({},'', '#two');return location.href})()");
    const started = Date.now();
    const back = JSON.parse(await ok("navigate", { tabId, url: "back", waitUntil: "load" }));
    assert.equal(new URL(back.url).hash, "#one");
    const forward = JSON.parse(await ok("navigate", { tabId, url: "forward", waitUntil: "load" }));
    assert.equal(new URL(forward.url).hash, "#two");
    assert.ok(Date.now() - started < 4000, "same-document traversal waited for a missing load event");
  });

  await test("history boundaries fail promptly without navigating", async () => {
    const emptyTab = await createTab();
    const before = JSON.parse(await ok("tabs_context_mcp", {})).tabs.find(tab => tab.tabId === emptyTab).url;
    const started = Date.now();
    for (const direction of ["back", "forward"]) {
      const result = await call("navigate", { tabId: emptyTab, url: direction, waitUntil: "load" });
      assert.ok(result.isError && /history/i.test(result.text), result.text);
    }
    assert.ok(Date.now() - started < 4000, "history boundary waited for a load timeout");
    const context = JSON.parse(await ok("tabs_context_mcp", {}));
    assert.equal(context.tabs.find(tab => tab.tabId === emptyTab).url, before);
  });

  for (const condition of [
    { selector: "#arrived" },
    { text: "navigation-complete-marker" },
    { predicate: "location.pathname === '/end' && !!document.querySelector('#arrived')" },
  ]) {
    await test(`${Object.keys(condition)[0]} wait survives a full document change`, async () => {
      await navigate("/start");
      await scheduleNavigation();
      await ok("wait_for", { tabId, ...condition, timeoutMs: 2500 });
      assert.match(await evaluate("location.pathname"), /\/end/);
    });
  }

  await test("a missing condition keeps one deadline across a document change", async () => {
    await navigate("/start");
    await scheduleNavigation();
    const started = Date.now();
    const result = await call("wait_for", { tabId, selector: "#never-present", timeoutMs: 1400 });
    const elapsed = Date.now() - started;
    assert.ok(result.isError && /timed out after 1400ms/.test(result.text), result.text);
    assert.ok(elapsed >= 1300 && elapsed < 1900, `wait used ${elapsed} ms instead of one 1400 ms deadline`);
    const observations = waitDiagnostics(result.text);
    assert.ok(observations.completedPollCount > 0);
    assert.ok(observations.polls.length <= 8);
    assert.ok(observations.document.changeCount >= 1, "the document replacement was not observed");
    assert.equal(observations.lastObservation.ok, false);
  });

  await test("a slow page probe cannot extend the deadline or keep polling afterward", async () => {
    await navigate("/start");
    const started = Date.now();
    const result = await call("wait_for", {
      tabId,
      timeoutMs: 250,
      // A bounded renderer stall exercises the worker deadline independently
      // of page timers. It runs only on this suite's disposable fixture.
      predicate: "(()=>{window.__waitProbeRuns=(window.__waitProbeRuns||0)+1;const until=performance.now()+1000;while(performance.now()<until){};return false})()",
    });
    const elapsed = Date.now() - started;
    assert.ok(result.isError && /timed out after 250ms/.test(result.text), result.text);
    assert.ok(elapsed >= 200 && elapsed < 800, `slow probe held the call for ${elapsed} ms`);
    const observations = waitDiagnostics(result.text);
    assert.equal(observations.completedPollCount, 0);
    assert.ok(observations.unfinishedProbe, "the stalled probe was reported as a completed false poll");
    await sleep(1200);
    assert.equal(await evaluate("window.__waitProbeRuns"), "1", "polling continued after timeout");
  });

  await test("a new report generation settles even when the result numbers are unchanged", async () => {
    await navigate("/report");
    const generation = Number(await evaluate("document.getElementById('report-generation').dataset.generation"));
    const originalResult = await evaluate("document.getElementById('report-result').textContent");
    const immediate = JSON.parse(await evaluate(`(() => {
      window.requestFixtureReport(2);
      return { setting: document.getElementById('report-setting').value,
        generation: Number(document.getElementById('report-generation').dataset.generation) };
    })()`));
    assert.equal(immediate.setting, "2", "settings did not update immediately");
    assert.equal(immediate.generation, generation,
      "the fixture report settled before the settings read-back");
    const settled = JSON.parse(await ok("wait_for", {
      tabId,
      predicate: `Number(document.getElementById('report-generation').dataset.generation) > ${generation} && document.getElementById('report-generation').dataset.busy === 'false'`,
      stableForMs: 200,
      timeoutMs: 4000,
    }));
    assert.ok(settled.diagnostics.stableElapsedMs >= 200);
    assert.equal(await evaluate("document.getElementById('report-result').textContent"), originalResult,
      "the fixture must permit an unchanged report result");
  });

  await test("a report marker arriving after timeout cannot satisfy the expired wait", async () => {
    await navigate("/report");
    await evaluate("window.requestFixtureReport(3)");
    const predicate = "document.getElementById('report-generation').dataset.generation === '1' && document.getElementById('report-generation').dataset.busy === 'false'";
    const expired = await call("wait_for", { tabId, predicate, timeoutMs: 150 });
    assert.equal(expired.isError, true, expired.text);
    const observations = waitDiagnostics(expired.text);
    assert.equal(observations.lastObservation?.ok, false);
    await ok("wait_for", { tabId, predicate, stableForMs: 100, timeoutMs: 3000 });
    assert.match(expired.text, /timed out after 150ms/);
  });

  await test("selector waits distinguish visible, hidden and detached states", async () => {
    await navigate("/start");
    await evaluate(`(() => {
      const element = document.createElement('div');
      element.id = 'state-marker'; element.textContent = 'state fixture'; element.style.display = 'none';
      document.body.appendChild(element);
      setTimeout(() => { element.style.display = 'block'; }, 200);
    })()`);
    await ok("wait_for", { tabId, selector: "#state-marker", state: "attached", timeoutMs: 2000 });
    await ok("wait_for", { tabId, selector: "#state-marker", state: "visible", stableForMs: 100, timeoutMs: 2000 });
    await evaluate("setTimeout(() => { document.getElementById('state-marker').style.display = 'none'; }, 200)");
    await ok("wait_for", { tabId, selector: "#state-marker", state: "hidden", stableForMs: 100, timeoutMs: 2000 });
    assert.equal(await evaluate("!!document.getElementById('state-marker')"), "true");
    await evaluate("setTimeout(() => { document.getElementById('state-marker').remove(); }, 200)");
    await ok("wait_for", { tabId, selector: "#state-marker", state: "detached", stableForMs: 100, timeoutMs: 2000 });
  });

  await test("network idle restarts its quiet interval in the new document", async () => {
    await navigate("/start");
    await scheduleNavigation("/end");
    const started = Date.now();
    await ok("wait_for", { tabId, networkIdle: true, idleMs: 800, timeoutMs: 2500 });
    const elapsed = Date.now() - started;
    assert.match(await evaluate("location.pathname"), /\/end/);
    assert.ok(elapsed >= 1000, `idle used ${elapsed} ms and counted quiet time from the old document`);
  });

  await test("predicate stability restarts in the new document", async () => {
    await navigate("/start");
    await scheduleNavigation("/end");
    const started = Date.now();
    const result = JSON.parse(await ok("wait_for", { tabId, predicate: "true", stableForMs: 800, timeoutMs: 3000 }));
    assert.ok(Date.now() - started >= 1000, "stability counted truth from the replaced document");
    assert.ok(result.diagnostics.document.changeCount >= 1);
    assert.match(await evaluate("location.pathname"), /\/end/);
  });

  await test("closing a tab ends a pending wait promptly", async () => {
    const closingTab = await createTab();
    await ok("navigate", { tabId: closingTab, url: origin + "/start", waitUntil: "load" });
    const started = Date.now();
    const pending = call("wait_for", { tabId: closingTab, selector: "#never-present", timeoutMs: 5000 });
    await sleep(300);
    await ok("tabs_close_mcp", { tabId: closingTab });
    tabs.delete(closingTab);
    const result = await pending;
    assert.ok(result.isError && /not found|closed|no tab/i.test(result.text), result.text);
    assert.ok(Date.now() - started < 2500, "closed tab waited for the condition deadline");
  });

  await test("closing a tab ends a pending predicate wait promptly", async () => {
    const closingTab = await createTab();
    await ok("navigate", { tabId: closingTab, url: origin + "/csp", waitUntil: "load" });
    const started = Date.now();
    const pending = call("wait_for", { tabId: closingTab, predicate: "window.__neverSet === 1", timeoutMs: 5000 });
    await sleep(300);
    await ok("tabs_close_mcp", { tabId: closingTab });
    tabs.delete(closingTab);
    const result = await pending;
    assert.ok(result.isError && /not found|closed|no tab/i.test(result.text), result.text);
    assert.ok(Date.now() - started < 2500, "closed tab waited for the condition deadline");
  });

  // ---- strict-CSP evaluation -----------------------------------------------
  // The fixture's policy is proved through the page's OWN eval, so these cases
  // cannot pass by accident on a document that never enforced a policy.
  const pageEvalStatus = async () => {
    const text = await ok("get_page_text", { tabId });
    return /page-eval-blocked/.test(text) ? "blocked" : /page-eval-ran/.test(text) ? "ran" : `unknown (${text.slice(0, 120)})`;
  };

  await test("the fixture's page CSP blocks the page's own string evaluation", async () => {
    await navigate("/csp");
    assert.equal(await pageEvalStatus(), "blocked", "fixture did not enforce a strict script-src");
  });

  await test("javascript_tool reads the DOM of a strict-CSP page", async () => {
    await navigate("/csp");
    assert.match(await evaluate("document.getElementById('csp-marker').textContent"), /strict-csp-marker/);
  });

  await test("a tool evaluation leaves ordinary page eval blocked", async () => {
    await navigate("/csp");
    assert.equal(await pageEvalStatus(), "blocked", "page eval was permitted before the tool call");
    // Clear the marker, then let the page's own timer retest its privileges.
    await evaluate("document.getElementById('evalstatus').textContent='page-eval-untested'");
    const settled = await call("wait_for", { tabId, text: "page-eval-blocked", timeoutMs: 5000 });
    assert.equal(settled.isError, false, `page eval was still permitted after a tool call: ${settled.text}`);
  });

  await test("values, escaping and completion values survive transport", async () => {
    await navigate("/csp");
    const tricky = 'a"b\\c\nd e';
    assert.equal(await evaluate(JSON.stringify(tricky)), tricky);
    assert.deepEqual(JSON.parse(await evaluate("[1,'two',{three:3},null]")), [1, "two", { three: 3 }, null]);
    assert.equal(await evaluate("var completionValue = 21; completionValue * 2"), "42");
    assert.equal(await evaluate("if (true) { 'from-a-block' }"), "from-a-block");
    assert.equal(await evaluate("void 0"), "null");
    assert.equal(await evaluate("false"), "false");
  });

  await test("serialization and error diagnostics stay useful", async () => {
    await navigate("/csp");
    for (const [text, pattern] of [
      ["document.body", /DOM node/i],
      ["(function serializeMe(){})", /function/i],
      ["1n", /not JSON-serializable/i],
      ["(()=>{const cycle={};cycle.self=cycle;return cycle})()", /not JSON-serializable/i],
      ["function (", /Page JS error/],
      ["(()=>{throw new Error('boom-from-page')})()", /boom-from-page/],
    ]) {
      const result = await call("javascript_tool", { tabId, text });
      assert.ok(result.isError && pattern.test(result.text), `${text} -> ${result.text}`);
    }
  });

  await test("thenables keep their result and error meaning", async () => {
    await navigate("/csp");
    assert.equal(await evaluate("Promise.resolve(7)"), "7");
    assert.equal(await evaluate("({then:(resolve)=>resolve(42)})"), "42");
    const rejected = await call("javascript_tool", { tabId, text: "Promise.reject(new Error('rejected-in-page'))" });
    assert.ok(rejected.isError && /rejected-in-page/.test(rejected.text), rejected.text);
  });

  await test("a mutation followed by nested eval runs exactly once", async () => {
    await navigate("/csp");
    await evaluate("window.__cspMutations = 0");
    const nested = "(()=>{window.__cspMutations++; return (0,eval)('window.__cspMutations')})()";
    assert.equal(await evaluate(nested), "1");
    assert.equal(await evaluate("window.__cspMutations"), "1", "the supplied script ran more than once");
  });

  await test("predicates keep false polling and synchronous Promise truthiness", async () => {
    await navigate("/csp");
    const started = Date.now();
    const waited = await call("wait_for", { tabId, predicate: "false", timeoutMs: 700 });
    assert.ok(waited.isError && /timed out after 700ms/.test(waited.text), waited.text);
    assert.ok(Date.now() - started >= 600, "a false predicate stopped polling before its deadline");
    const promiseStarted = Date.now();
    await ok("wait_for", { tabId, predicate: "Promise.resolve(false)", timeoutMs: 5000 });
    assert.ok(Date.now() - promiseStarted < 2000, "a Promise object was awaited instead of treated as truthy");
  });

  for (const predicate of ["(", "return true", "new.target"]) {
    await test(`a malformed Script predicate ${JSON.stringify(predicate)} fails promptly`, async () => {
      await navigate("/csp");
      const started = Date.now();
      const result = await call("wait_for", { tabId, predicate, timeoutMs: 9000 });
      const elapsed = Date.now() - started;
      assert.ok(result.isError, result.text);
      assert.ok(/syntax/i.test(result.text), `no syntax diagnostic: ${result.text}`);
      assert.doesNotMatch(result.text, /timed out/i, "a permanent syntax error was retried until timeout");
      assert.ok(elapsed < 4000, `a malformed predicate took ${elapsed} ms to report`);
    });
  }

  await test("a predicate accepts a hashbang followed by a truthy Script completion", async () => {
    await navigate("/csp");
    const started = Date.now();
    await ok("wait_for", { tabId, predicate: "#! predicate\ntrue", timeoutMs: 5000 });
    assert.ok(Date.now() - started < 2000, "a valid truthy Script did not complete promptly");
  });

  await test("a transient predicate error keeps polling until the page settles", async () => {
    await navigate("/csp");
    await evaluate("setTimeout(()=>{window.__cspLate={ready:true}},600)");
    await ok("wait_for", { tabId, predicate: "window.__cspLate.ready === true", timeoutMs: 6000 });
  });

  await test("a runtime JSON.parse SyntaxError is retried until valid data arrives", async () => {
    await navigate("/csp");
    await evaluate("window.__cspPendingJSON = ''");
    const pending = call("wait_for", {
      tabId,
      predicate: `(() => {
        window.__cspJSONPolls = (window.__cspJSONPolls || 0) + 1;
        try { return JSON.parse(window.__cspPendingJSON).ready === true; }
        catch (error) { window.__cspJSONError = error.name; throw error; }
      })()`,
      timeoutMs: 6000,
    });
    try {
      // Only the pending predicate writes this marker: prove it encountered the
      // native runtime SyntaxError before allowing the fixture data to settle.
      await ok("wait_for", { tabId, predicate: "window.__cspJSONError === 'SyntaxError'", timeoutMs: 2000 });
      await evaluate("window.__cspPendingJSON = '{\"ready\":true}'");
      const result = await pending;
      assert.equal(result.isError, false, result.text);
      assert.ok(Number(await evaluate("window.__cspJSONPolls")) >= 2, "the predicate did not retry after its runtime error");
    } finally {
      await pending;
    }
  });

  await test("a loading document answers predicates before its slow script arrives", async () => {
    await navigate("/start");
    let navigated = false;
    const navigating = call("navigate", { tabId, url: origin + "/csp?slow=1500", waitUntil: "load" })
      .then(result => { navigated = true; return result; });
    try {
      await ok("wait_for", { tabId, predicate: "!!document.getElementById('csp-marker')", timeoutMs: 8000 });
      const malformed = await call("wait_for", { tabId, predicate: "(", timeoutMs: 8000 });
      assert.ok(malformed.isError && /syntax/i.test(malformed.text), malformed.text);
      assert.equal(navigated, false, "the slow subresource had already finished loading");
    } finally {
      await navigating;
    }
  });

  await test("a pending predicate follows a same-URL reload into the new document", async () => {
    await navigate("/csp");
    await evaluate("window.__cspOldDocumentOnly = 'old'");
    const started = Date.now();
    let settled = false;
    const pending = call("wait_for", {
      tabId,
      predicate: `(() => {
        window.__cspReloadPolled = window.__cspOldDocumentOnly === 'old' ? 'old' : 'new';
        return window.__cspReloadPolled === 'new' && !!document.getElementById('csp-marker');
      })()`,
      timeoutMs: 5000,
    }).then(result => { settled = true; return result; });
    try {
      // A fixture marker confirms the pending wait really polled the old
      // document before the reload; starting two calls alone cannot prove that.
      await ok("wait_for", { tabId, predicate: "window.__cspReloadPolled === 'old'", timeoutMs: 2000 });
      assert.equal(settled, false, "the pending wait accepted the old document");
      await ok("tab_reload", { tabId, waitUntil: "load" });
      const result = await pending;
      assert.equal(result.isError, false, result.text);
      assert.ok(Date.now() - started < 5000, "the reload extended the pending wait's deadline");
      assert.equal(await evaluate("window.__cspReloadPolled"), "new", "the new document was never polled");
      assert.equal(await evaluate("typeof window.__cspOldDocumentOnly"), "undefined");
    } finally {
      await pending;
    }
  });

  await test("a pending predicate keeps one deadline across a same-URL reload", async () => {
    await navigate("/csp");
    await evaluate("window.__cspOldDocumentOnly = 'old'");
    const started = Date.now();
    const pending = call("wait_for", {
      tabId,
      predicate: "(()=>{window.__cspDeadlinePolled=window.__cspOldDocumentOnly || 'new';return false})()",
      timeoutMs: 2000,
    });
    try {
      await ok("wait_for", { tabId, predicate: "window.__cspDeadlinePolled === 'old'", timeoutMs: 1500 });
      // Leave enough elapsed time to distinguish the original deadline from a
      // fresh timeout incorrectly started after the replacement document loads.
      await sleep(900);
      await ok("tab_reload", { tabId, waitUntil: "load" });
      const result = await pending;
      const elapsed = Date.now() - started;
      assert.ok(result.isError && /timed out after 2000ms/.test(result.text), result.text);
      assert.ok(elapsed >= 1900 && elapsed < 2600, `reload wait used ${elapsed} ms instead of one 2000 ms deadline`);
      assert.equal(await evaluate("window.__cspDeadlinePolled"), "new", "the wait never polled the replacement document");
    } finally {
      await pending;
    }
  });

  await test("a pending predicate wait follows a history restoration", async () => {
    await ok("navigate", { tabId, url: origin + "/bfcache-a", waitUntil: "load" });
    await ok("navigate", { tabId, url: origin + "/bfcache-b", waitUntil: "load" });
    let settled = false;
    const pending = call("wait_for", {
      tabId,
      predicate: "(()=>{window.__cspHistoryPolled=location.pathname;return location.pathname === '/bfcache-a' && !!document.getElementById('persisted')})()",
      timeoutMs: 9000,
    }).then(result => { settled = true; return result; });
    try {
      await ok("wait_for", { tabId, predicate: "window.__cspHistoryPolled === '/bfcache-b'", timeoutMs: 2000 });
      assert.equal(settled, false, "the history wait settled before traversing back");
      await ok("navigate", { tabId, url: "back", waitUntil: "load" });
      const result = await pending;
      assert.equal(result.isError, false, result.text);
      assert.equal(await evaluate("window.__cspHistoryPolled"), "/bfcache-a", "the restored document was never polled");
      bfcacheObservation = (await evaluate("document.getElementById('persisted').textContent")).trim();
      assert.match(bfcacheObservation, /^(restored-from-bfcache|freshly-loaded)$/);
    } finally {
      await pending;
    }
  });
} finally {
  await cleanup();
  stopWatchdog();
}
console.log(`\nNavigation regressions: ${passes} passed, ${failures} failed`);
console.log(`back/forward restoration: ${bfcacheObservation}`);
process.exitCode = failures ? 1 : 0;
