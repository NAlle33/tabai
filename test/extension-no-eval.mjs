// The extension's content security policy forbids evaluating strings, so no built extension
// bundle may construct `Function` while it loads, as zod 4 does to test whether it may compile
// its validators. Each bundle is evaluated in a vm context whose `Function` counts its calls and
// throws as the policy does; browser APIs are inert stand-ins. A control build of every bundle
// that contains zod, without the module that switches compilation off, must make the call: that
// shows the evaluation reaches the schemas, and that the switch is what keeps the call away.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { build } from "esbuild";
import { watchdog } from "./watchdog.mjs";

const stopWatchdog = watchdog();
// A bundle's asynchronous start-up code fails against the stand-ins after its schemas are
// built. Its errors belong to the vm context's realm and are ignored; this test's own are not.
for (const event of ["unhandledRejection", "uncaughtException"]) process.on(event, error => { if (error instanceof Error) { console.error(error); process.exit(1); } });
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entries = ["background", "offscreen", "popup", "sidepanel", "content"];
const SWITCH = "zod-no-eval";

/** Any property, call or construction gives another stand-in; assignments are ignored. */
const inert = () => new Proxy(function () {}, {
  get: (_target, key) => key === Symbol.toPrimitive ? () => "" : key === Symbol.iterator ? function* () {} : key === "then" ? undefined : inert(),
  set: () => true, defineProperty: () => true, apply: () => inert(), construct: () => inert(),
});
/** Evaluates one bundle; returns how often it constructed or called `Function`, and zod's configuration after it ran. */
function evaluate(code, label) {
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} }, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    queueMicrotask() {}, URL, URLSearchParams, TextEncoder, TextDecoder, crypto: globalThis.crypto, structuredClone, atob, btoa, AbortController, performance,
    chrome: inert(), document: inert(), location: inert(), WebSocket: inert(), navigator: { userAgent: "Mozilla/5.0 Chrome/131" }, addEventListener() {}, removeEventListener() {},
    customElements: inert(), MutationObserver: inert(), ResizeObserver: inert(), matchMedia: inert(), fetch: inert(), FileReader: inert(),
    HTMLElement: class {}, Event: class {}, CustomEvent: class {}, Blob: class {}, File: class {},
  };
  sandbox.self = sandbox; sandbox.window = sandbox; sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  let calls = 0;
  const refuse = () => { calls++; throw new EvalError("Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source"); };
  sandbox.Function = new Proxy(vm.runInContext("Function", context), { construct: refuse, apply: refuse });
  // The stand-ins end a bundle's own start-up code early; its schemas are built before that.
  try { vm.runInContext(code, context, { filename: label }); } catch { /* the count and the configuration are what matter */ }
  // zod keeps its configuration on the global object, shared by every copy in the context.
  return { calls, jitless: sandbox.__zod_globalConfig?.jitless === true };
}

try {
  let controls = 0;
  for (const name of entries) {
    const built = readFileSync(join(root, "extension", "dist", `${name}.js`), "utf8");
    const run = evaluate(built, `${name}.js`);
    assert.equal(run.calls, 0, `${name}.js evaluates no string while it loads`);
    if (!built.includes("$ZodObject")) continue;
    // A switch that failed to load would also leave no call: zod must really be configured jitless.
    assert.equal(run.jitless, true, `${name}.js runs zod without compilation`);
    // Every entry that bundles zod switches compilation off with its very first import.
    const source = readFileSync(join(root, "extension", "src", `${name}.ts`), "utf8");
    assert.equal(/^import\s[^;]*;/m.exec(source)?.[0], `import "./${SWITCH}";`, `${name}.ts imports ./${SWITCH} first`);
    const control = await build({
      entryPoints: [join(root, "extension", "src", `${name}.ts`)], bundle: true, write: false, platform: "browser", format: "iife", target: "chrome116", logLevel: "error",
      plugins: [{ name: "without-switch", setup(bundle) { bundle.onLoad({ filter: new RegExp(`[\\\\/]${SWITCH}\\.ts$`) }, () => ({ contents: "", loader: "ts" })); } }],
    });
    const without = evaluate(control.outputFiles[0].text, `${name}.js without ${SWITCH}`);
    assert.ok(without.calls > 0 && !without.jitless, `without ${SWITCH}, ${name}.js would compile and test string evaluation while it loads`);
    controls++;
  }
  assert.ok(controls >= 3, `the background worker, the offscreen document and the side panel bundle zod (${controls} found)`);
  console.log(`extension-no-eval: ${entries.length} bundles load without evaluating a string; ${controls} zod bundles would without the switch`);
} finally {
  stopWatchdog();
}
