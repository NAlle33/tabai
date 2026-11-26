// A server started with CCMCP_UPLOAD_DENY_ROOT gives a page only regular files outside that
// root, on every route that reaches the browser: a direct call, a batch step and a recipe step
// whose path is assembled from parameters. Without the variable nothing is refused.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerCatalog } from "../dist/tool-catalog.mjs";
import { RecipeStore } from "../dist/recipe-store.mjs";
import { RunHistory } from "../dist/run-history.mjs";
import { WorkflowControl } from "../dist/workflow-control.mjs";
import { recipeSchema } from "../dist/workflow-schema.mjs";
import { EXTENSION_VERSION } from "../dist/protocol.mjs";
import { watchdog } from "./watchdog.mjs";

const stopWatchdog = watchdog(async () => {
  for (const client of clients) await client.close().catch(() => {});
  for (const path of tempUploads) rmSync(path, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
});
const base = mkdtempSync(join(tmpdir(), "tabai-upload-guard-"));
const root = join(base, "private"), secret = join(root, "assistant", "secret.json");
const outside = join(base, "public", "report.pdf"), link = join(base, "public", "link.json");
mkdirSync(dirname(secret), { recursive: true }); mkdirSync(dirname(outside), { recursive: true });
writeFileSync(secret, "{}"); writeFileSync(outside, "%PDF-1.4");
let linked = true;
try { symlinkSync(secret, link); } catch { linked = false; } // Windows without symlink rights.
const tempUploads = new Set();
const clients = [];
const text = result => result.content.map(item => item.text ?? "").join("\n");
const dispatched = calls => calls.filter(call => ["file_upload", "file_drop"].includes(call.tool));

/** One catalog over a fake bridge; the deny root comes from the environment at registration. */
async function catalog(denyRoot) {
  if (denyRoot) process.env.CCMCP_UPLOAD_DENY_ROOT = denyRoot; else delete process.env.CCMCP_UPLOAD_DENY_ROOT;
  const calls = [];
  const bridge = {
    connected: true, pendingCount: 0, configurePanel() {}, activity: () => ({ calls: [] }),
    async call(tool, args) {
      calls.push({ tool, args });
      if (tool === "health") return { extVersion: EXTENSION_VERSION };
      if (tool === "computer") return { base64: Buffer.from("png").toString("base64") };
      return { ok: true };
    },
  };
  const dir = mkdtempSync(join(base, "store-"));
  const server = new McpServer({ name: "upload-guard", version: "1.0.0" });
  registerCatalog(server, { bridge, recipes: new RecipeStore(join(dir, "recipes.json"), value => recipeSchema.parse(value)),
    history: new RunHistory(join(dir, "runs")), workflows: new WorkflowControl(), tempUploads, serverVersion: EXTENSION_VERSION });
  delete process.env.CCMCP_UPLOAD_DENY_ROOT;
  const client = new Client({ name: "upload-guard-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  clients.push(client);
  const saved = await client.callTool({ name: "recipe_save", arguments: { name: "upload", parameters: { dir: { type: "string" }, name: { type: "string" } },
    actions: [{ tool: "file_upload", args: { tabId: 1, ref: "ref_1", paths: ["{{dir}}{{name}}"] } }] } });
  assert.notEqual(saved.isError, true, text(saved));
  // Each route with the path it sends; the recipe receives the path in two parameters.
  const routes = {
    direct: path => client.callTool({ name: "file_upload", arguments: { tabId: 1, ref: "ref_1", paths: [path] } }),
    drop: path => client.callTool({ name: "file_drop", arguments: { tabId: 1, ref: "ref_1", path } }),
    image: path => client.callTool({ name: "upload_image", arguments: { tabId: 1, ref: "ref_1", ...(path === undefined ? {} : { path }) } }),
    batch: path => client.callTool({ name: "browser_batch", arguments: { actions: [{ tool: "file_upload", args: { tabId: 1, ref: "ref_1", paths: [path] } }] } }),
    batchDrop: path => client.callTool({ name: "browser_batch", arguments: { actions: [{ tool: "file_drop", args: { tabId: 1, ref: "ref_1", path } }] } }),
    recipe: path => client.callTool({ name: "recipe_run", arguments: { name: "upload", parameters: { dir: dirname(path) + sep, name: basename(path) } } }),
  };
  return { client, calls, routes };
}

try {
  const refused = [["a file inside the root", secret], ["the root itself", root], ["the root's parent directory", base], ["a missing file", join(base, "public", "absent.pdf")],
    ["a relative path", "report.pdf"], ...(linked ? [["a link outside the root to a file inside it", link]] : [])];
  {
    const { client, calls, routes } = await catalog(root);
    for (const [route, send] of Object.entries(routes)) {
      for (const [why, path] of refused) {
        if (route === "recipe" && why === "a relative path") continue; // A recipe path here is always assembled from a directory.
        calls.length = 0;
        const result = await send(path);
        assert.equal(result.isError, true, `${route}: ${why} is refused`);
        // file_drop's own existence check answers first for a path that names nothing.
        assert.match(text(result), route === "drop" && ["a missing file", "a relative path"].includes(why) ? /File not found/ : /FILE_REFUSED/, `${route}: ${why} names the refusal`);
        assert.equal(dispatched(calls).length, 0, `${route}: ${why} never reaches the browser`);
        if (result.structuredContent?.steps) assert.equal(result.structuredContent.steps[0].actionState, "not-started", `${route}: ${why} is reported as not dispatched`);
      }
      calls.length = 0;
      const result = await send(outside);
      assert.notEqual(result.isError, true, `${route}: a file outside the root passes: ${text(result)}`);
      const sent = dispatched(calls);
      assert.equal(sent.length, 1, `${route}: dispatched once`);
      assert.deepEqual(sent[0].args.paths ?? [sent[0].args.path], [outside], `${route}: the path is sent as given`);
    }
    // A fresh screenshot is written to the system temp directory, outside the root.
    calls.length = 0;
    const shot = await routes.image();
    assert.notEqual(shot.isError, true, text(shot));
    assert.equal(dispatched(calls).length, 1, "a screenshot upload is not refused");
    // One private path refuses the whole upload, whatever else it names.
    calls.length = 0;
    const mixed = await client.callTool({ name: "file_upload", arguments: { tabId: 1, ref: "ref_1", paths: [outside, secret] } });
    assert.equal(mixed.isError, true, "one private path refuses the whole upload");
    assert.match(text(mixed), /FILE_REFUSED/);
    assert.equal(dispatched(calls).length, 0);
  }
  /** Every route refuses each private path before dispatch and sends the public one once, as given. */
  const refusesOnEveryRoute = async (label, privatePaths, publicPath) => {
    const { calls, routes } = await catalog(root);
    for (const [route, send] of Object.entries(routes)) {
      for (const path of privatePaths) {
        calls.length = 0;
        const result = await send(path);
        assert.equal(result.isError, true, `${route}: ${label} ${path} is refused`);
        assert.match(text(result), /FILE_REFUSED/, `${route}: ${label} names the refusal`);
        assert.equal(dispatched(calls).length, 0, `${route}: ${label} never reaches the browser`);
        if (result.structuredContent?.steps) assert.equal(result.structuredContent.steps[0].actionState, "not-started", `${route}: ${label} is reported as not dispatched`);
      }
      if (publicPath === undefined) continue;
      calls.length = 0;
      const result = await send(publicPath);
      assert.notEqual(result.isError, true, `${route}: a file outside the root passes ${label}: ${text(result)}`);
      const sent = dispatched(calls);
      assert.equal(sent.length, 1, `${route}: dispatched once ${label}`);
      assert.deepEqual(sent[0].args.paths ?? [sent[0].args.path], [publicPath], `${route}: the path is sent as given ${label}`);
    }
  };
  {
    // macOS names every directory of its data volume a second time under /System/Volumes/Data.
    // The two names are the same directory without a link between them, so the real path of
    // the alias is the alias itself and only the directory's identity shows where it lies.
    const alias = path => join("/System/Volumes/Data", realpathSync.native(path));
    if (process.platform !== "darwin" || !existsSync(alias(secret))) console.log("upload path guard: SKIPPED the /System/Volumes/Data alias check (macOS with a separate data volume only)");
    else await refusesOnEveryRoute("through the data-volume alias", [alias(secret)], alias(outside));
  }
  {
    // A share or device-namespace path can name a local directory under another name on Windows.
    if (process.platform !== "win32") console.log("upload path guard: SKIPPED the share and device path check (Windows only)");
    else await refusesOnEveryRoute("as a device-namespace path", [`\\\\?\\${outside}`]);
  }
  {
    // A deny root that cannot be checked proves nothing about any file, so nothing is given.
    const { calls, routes } = await catalog(join(base, "absent-root"));
    calls.length = 0;
    const result = await routes.direct(outside);
    assert.equal(result.isError, true, "a deny root that cannot be checked refuses every file");
    assert.match(text(result), /FILE_REFUSED: Tabai's private data directory could not be checked/);
    assert.equal(dispatched(calls).length, 0);
  }
  {
    // Another MCP session sets no deny root: every path reaches the browser exactly as before.
    const { calls, routes } = await catalog(undefined);
    for (const [route, send] of Object.entries(routes)) {
      for (const [why, path] of [["a file inside the root", secret], ["the root itself", root], ["the root's parent directory", base]]) {
        calls.length = 0;
        const result = await send(path);
        assert.notEqual(result.isError, true, `${route}: without a deny root ${why} is not refused: ${text(result)}`);
        assert.equal(dispatched(calls).length, 1, `${route}: ${why} reaches the browser`);
      }
    }
  }
  console.log("upload path guard: direct, batch and recipe routes refuse private and non-regular paths; other sessions unchanged");
} finally {
  for (const client of clients) await client.close().catch(() => {});
  // The server keeps each synthesized upload in a private directory of its own.
  for (const path of tempUploads) rmSync(path, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
  stopWatchdog();
}
