// The MAIN-world content script records every console call on every page. Its
// formatter must never run page code (getters, toJSON) and must stay bounded
// in depth, keys per level and output length, however large the logged value.
import assert from "node:assert/strict";
import vm from "node:vm";
import v8 from "node:v8";
import { build } from "esbuild";
import { watchdog } from "./watchdog.mjs";

const stopWatchdog = watchdog();
const bundle = await build({ entryPoints: ["extension/src/content.ts"], bundle: true, write: false,
  platform: "browser", format: "iife", logLevel: "silent" });
const silent = () => {};
const listeners = {}, pageCalls = [];
const page = { addEventListener: (type, listener) => { listeners[type] = listener; } };
const sandbox = { window: page, console: { log: (...args) => { pageCalls.push(args); }, info: silent, warn: silent, error: silent, debug: silent } };
const context = vm.createContext(sandbox);
// The browser's own Object.keys, instrumented before the content script captures
// it at document start: it counts key enumerations of binary views.
vm.runInContext(`{ const realKeys = Object.keys; globalThis.binaryKeyReads = 0;
  Object.keys = function keys(value) { if (ArrayBuffer.isView(value)) globalThis.binaryKeyReads++; return realKeys(value); }; }`, context);
// The same for String wrapper objects, which list one key per character.
vm.runInContext(`{ const countedKeys = Object.keys, apply = Reflect.apply, unbox = String.prototype.valueOf; globalThis.boxedKeyReads = 0;
  Object.keys = function keys(value) { try { apply(unbox, value, []); globalThis.boxedKeyReads++; } catch {} return countedKeys(value); }; }`, context);
vm.runInContext(bundle.outputFiles[0].text, context);
const logged = (...args) => { sandbox.console.log(...args); return page.__ccmcpConsole.at(-1).text; };

let pageCodeRan = 0;
const trap = {
  plain: 1,
  get secret() { pageCodeRan++; return "from getter"; },
  toJSON() { pageCodeRan++; return "from toJSON"; },
};
const text = logged("value", trap);
assert.equal(pageCodeRan, 0, "a getter or toJSON on a logged object ran");
assert.match(text, /^value \{/);
assert.match(text, /"plain":1/);
assert.doesNotMatch(text, /from getter|from toJSON/);
console.log("  ✓ getters and toJSON are never called");

const nested = { a: { b: { c: { d: "too deep" } } } };
const deep = logged(nested);
assert.doesNotMatch(deep, /too deep/);
assert.match(deep, /"a":\{"b":/);
console.log("  ✓ nesting is cut off at depth 2");

const wide = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`key${i}`, i]));
const wideText = logged(wide);
assert.match(wideText, /"key19":19/);
assert.doesNotMatch(wideText, /"key20"/);
const longList = logged(Array.from({ length: 1000 }, (_, i) => i));
assert.match(longList, /19/);
assert.doesNotMatch(longList, /\b20\b/);
console.log("  ✓ at most 20 keys or items per level");

let read = 0;
const huge = new Proxy(Array.from({ length: 1e5 }, () => "x".repeat(100)), {
  get(target, key, receiver) { read++; return Reflect.get(target, key, receiver); },
  getOwnPropertyDescriptor(target, key) { read++; return Reflect.getOwnPropertyDescriptor(target, key); },
});
const hugeText = logged(huge, "y".repeat(10_000));
assert.ok(hugeText.length <= 4000 + "…[truncated]".length, `entry is ${hugeText.length} characters`);
assert.ok(read <= 25, `the formatter read ${read} items of a large array`);
console.log("  ✓ output stays within 4000 characters without walking the whole value");

const cyclic = { name: "loop" }; cyclic.self = cyclic;
assert.match(logged(cyclic), /"name":"loop"/);
console.log("  ✓ cycles are cut off");

// Page scripts run after this content script and may replace builtins; MooTools
// replaces Array.from.
vm.runInContext(`globalThis.pageFromCalls = 0; globalThis.originalFrom = Array.from;
  Array.from = function from(item) { globalThis.pageFromCalls++; return item == null ? [] : [item]; };`, context);
try {
  assert.equal(logged([1, 2, 3]), "[1,2,3]");
  assert.equal(sandbox.pageFromCalls, 0, "the page's Array.from ran inside the formatter");
} finally { vm.runInContext("Array.from = globalThis.originalFrom;", context); }
console.log("  ✓ a page's replaced Array.from is never called");

const binary = logged(new Uint8Array(1e6), { view: new DataView(new ArrayBuffer(8)) });
assert.equal(sandbox.binaryKeyReads, 0, "the formatter enumerated the keys of a binary view");
assert.equal(binary, '[Binary] {"view":[Binary]}');
console.log("  ✓ typed arrays and DataViews are a fixed tag, never walked");

// A String wrapper is logged as its bounded, quoted string. The brand check was
// captured at document start: a page's later String.prototype.valueOf never runs.
const boxedHuge = vm.runInContext(`new String("x".repeat(1e6))`, context);
vm.runInContext(`globalThis.pageValueOfCalls = 0; globalThis.originalValueOf = String.prototype.valueOf;
  String.prototype.valueOf = function valueOf() { globalThis.pageValueOfCalls++; return "from the page"; };`, context);
let boxedText, hugeBoxedText;
try {
  boxedText = logged(vm.runInContext(`new String("abc")`, context), { boxed: vm.runInContext(`new String("in an object")`, context) });
  hugeBoxedText = logged(boxedHuge);
} finally { vm.runInContext("String.prototype.valueOf = globalThis.originalValueOf;", context); }
assert.equal(boxedText, '"abc" {"boxed":"in an object"}');
assert.equal(sandbox.pageValueOfCalls, 0, "the page's String.prototype.valueOf ran inside the formatter");
assert.equal(sandbox.boxedKeyReads, 0, "the formatter enumerated the keys of a String wrapper");
assert.match(hugeBoxedText, /^"x{100}/);
assert.ok(hugeBoxedText.length <= 4000 + "…[truncated]".length, `entry is ${hugeBoxedText.length} characters`);
console.log("  ✓ a String wrapper is a bounded quoted string, never one key per character");

// document.all is an object whose typeof is "undefined". Converting it would run
// the page's own conversion code, so it is written as the literal text.
v8.setFlagsFromString("--allow-natives-syntax");
let all;
try { all = vm.runInContext("%GetUndetectable()", context); } finally { v8.setFlagsFromString("--no-allow-natives-syntax"); }
assert.equal(typeof all, "undefined");
let conversions = 0;
all.toString = () => { conversions++; return "from the page"; };
all.valueOf = () => { conversions++; return "from the page"; };
let allText;
assert.doesNotThrow(() => { allText = logged(all, { all }); }, "logging an undetectable object reached the page's console call");
assert.equal(conversions, 0, "the page's conversion code ran inside the formatter");
assert.equal(allText, 'undefined {"all":undefined}');
console.log("  ✓ an object whose typeof is undefined is written as undefined without converting it");

// A page that breaks every builtin the formatter could look up while it runs:
// its own console call still runs and returns, and the entry is still recorded.
vm.runInContext(`globalThis.savedBuiltins = [[Array.prototype, "forEach"], [Array.prototype, "includes"], [Array.prototype, "push"],
  [Array.prototype, "pop"], [String.prototype, "slice"], [Function.prototype, "call"], [Function.prototype, "apply"],
  [globalThis, "String"], [globalThis, "Number"]].map(([target, name]) => [target, name, target[name]]);
  for (const [target, name] of globalThis.savedBuiltins) target[name] = function () { throw new Error("broken by the page"); };`, context);
const callsBefore = pageCalls.length;
try {
  assert.doesNotThrow(() => sandbox.console.log("x", { n: 1, list: [true, "s"], when: new Date(0) }, 2),
    "a failure inside the capture reached the page's console call");
} finally { vm.runInContext("for (const [target, name, value] of globalThis.savedBuiltins) target[name] = value;", context); }
assert.equal(pageCalls.length, callsBefore + 1, "the page's own console.log ran once");
assert.deepEqual([...pageCalls.at(-1)].map(value => typeof value), ["string", "object", "number"]);
assert.equal(page.__ccmcpConsole.at(-1).text, 'x {"n":1,"list":[true,"s"],"when":"1970-01-01T00:00:00.000Z"} 2');
console.log("  ✓ a page that breaks builtins cannot make its own console call fail or lose the entry");

// An unhandled rejection's reason is page data too: its own toString never runs.
let reasonCode = 0;
listeners.unhandledrejection({ reason: { code: 7, toString() { reasonCode++; return "from toString"; } } });
assert.equal(reasonCode, 0, "the rejection reason's own toString ran");
assert.equal(page.__ccmcpConsole.at(-1).text, 'Unhandled rejection: {"code":7,"toString":[Function]}');
listeners.unhandledrejection({ reason: "plain words" });
assert.equal(page.__ccmcpConsole.at(-1).text, "Unhandled rejection: plain words");
listeners.unhandledrejection({ reason: new Error("boom") });
assert.equal(page.__ccmcpConsole.at(-1).text, 'Unhandled rejection: {"message":"boom"}', "an error keeps its message");
console.log("  ✓ a rejection reason is formatted within the same bounds, without its own toString");
stopWatchdog();
console.log("=== content-console: PASS ===");
