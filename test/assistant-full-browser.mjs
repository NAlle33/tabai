import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AssistantMcpBrowser } from '../dist/assistant-mcp-browser.mjs';
import { assistantServerEnvironment } from '../dist/assistant-browser.mjs';
import { registerCatalog } from '../dist/tool-catalog.mjs';
import { RecipeStore } from '../dist/recipe-store.mjs';
import { RunHistory } from '../dist/run-history.mjs';
import { WorkflowControl } from '../dist/workflow-control.mjs';
import { recipeSchema } from '../dist/workflow-schema.mjs';
import { EXTENSION_VERSION } from '../dist/protocol.mjs';
import { AssistantExecutor, assistantCodexArgs, assistantClaudeArgs, assistantClaudeMcpConfig, assistantFullBrowserPrompt } from '../dist/assistant-agent.mjs';
import { assistantWorkerToolNames, assistantBrowserToolNames, ASSISTANT_BROWSER_REPLY_LIMIT, ASSISTANT_WORKER_READ_LIMIT, assistantWorkerLink } from '../dist/assistant-tools.mjs';
import { assistantWebAccessSchema, assistantWebEnabled } from '../dist/assistant-web.mjs';
import { watchdog } from './watchdog.mjs';

const stopWatchdog = watchdog(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
  rmSync(directory, { recursive: true, force: true });
});
const directory = mkdtempSync(join(tmpdir(), 'tf-'));
const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\tabai-full-${randomUUID()}` : join(directory, 's');
const sockets = new Set();
const image = { type: 'image', data: 'AA==', mimeType: 'image/png' };
// A screenshot above the MCP SDK's default stdio read limit of 10 MiB, which closes a link
// on one larger message. Kept near that default: the transfer slows with the square of its size.
const largeImage = { type: 'image', data: 'A'.repeat(11 * 1024 * 1024), mimeType: 'image/png' };
const requests = [];
const server = net.createServer(socket => {
  sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk;
    if (!buffer.endsWith('\n')) return;
    const frame = JSON.parse(buffer);
    assert.equal(frame.secret, 'test-secret'); requests.push(frame);
    const content = frame.args.name === 'screenshot' ? [image] : frame.args.name === 'large_screenshot' ? [largeImage] : [{ type: 'text', text: 'server validation error' }];
    socket.end(JSON.stringify({ ok: true, result: { content, ...(frame.args.name === 'invalid' ? { isError: true } : {}) } }));
  });
});

try {
  server.listen(socketPath); await once(server, 'listening');
  assert.equal(assistantWebAccessSchema.parse({ level: 'off', login: false }).fullAccess, undefined);
  assert.equal(assistantWebEnabled({ level: 'off', login: false, fullAccess: true }), true);
  assert.equal(assistantWebAccessSchema.safeParse({ level: 'off', login: false, fullAccess: 'true' }).success, false);

  for (const mode of [true, false, 'watch', 'routine']) {
    const legacy = assistantWorkerToolNames(mode, 'off');
    assert(!legacy.some(name => assistantBrowserToolNames.includes(name)));
    const expected = [...legacy, ...assistantBrowserToolNames];
    assert.deepEqual(assistantWorkerToolNames(mode, 'off', true), expected);
    const codex = assistantCodexArgs(directory, directory, undefined, mode, 'off', true);
    const value = codex.find(arg => arg.startsWith('mcp_servers.tabai_assistant.enabled_tools='));
    assert.deepEqual(JSON.parse(value.slice(value.indexOf('=') + 1)), expected);
    assert(codex.includes('features.shell_tool=false')); assert(codex.includes('features.unified_exec=false'));
    assert(codex.some(arg => arg.startsWith('mcp_servers.tabai_assistant.env_vars=') && arg.includes('TABAI_ASSISTANT_FULL_ACCESS')));
    const claude = assistantClaudeArgs('config.json', undefined, mode, 'off', true);
    assert.deepEqual(claude[claude.indexOf('--allowedTools') + 1].split(',').map(name => name.replace('mcp__tabai_assistant__', '')), expected);
    assert.equal(claude[claude.indexOf('--tools') + 1], '');
    assert.equal(assistantClaudeMcpConfig(directory, 'socket', 'secret', mode, 'off', true).mcpServers.tabai_assistant.env.TABAI_ASSISTANT_FULL_ACCESS, '1');
  }
  assert.match(assistantFullBrowserPrompt('original'), /original[\s\S]*mcp_browser_tools[\s\S]*mcp_browser_call/);
  const learningPrompt = assistantFullBrowserPrompt('original', true);
  assert.match(learningPrompt, /Börja med workflow_context\./);
  assert.match(learningPrompt, /browser_run_mail_method/);
  assert.match(learningPrompt, /Varje mcp_browser_call spärrar inlärning/);
  assert.match(learningPrompt, /Full Tabai-åtkomst är fortfarande tillgänglig/);
  assert.match(learningPrompt, /workflow- och browser_\*-verktygen i första hand/);
  assert.doesNotMatch(learningPrompt, /gäller detta läge framför/);

  // Exercise the real worker, including rich MCP results and strict opt-in parsing.
  for (const flag of [undefined, 'true', '1']) {
    const client = new Client({ name: 'full-browser-test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), 'dist/assistant-worker.mjs')],
      env: { TABAI_ASSISTANT_SOCKET: socketPath, TABAI_ASSISTANT_SECRET: 'test-secret', TABAI_ASSISTANT_CHAT: '1', ...(flag ? { TABAI_ASSISTANT_FULL_ACCESS: flag } : {}) }, stderr: 'ignore' }));
    try {
      const listed = (await client.listTools()).tools;
      assert.deepEqual(listed.map(tool => tool.name), assistantWorkerToolNames(true, 'off', flag === '1'));
      if (flag === '1') {
        assert.equal(listed.find(tool => tool.name === 'mcp_browser_tools').annotations.readOnlyHint, true);
        assert.equal(listed.find(tool => tool.name === 'mcp_browser_call').annotations.destructiveHint, true);
        assert.equal(listed.find(tool => tool.name === 'mcp_browser_call').annotations.openWorldHint, true);
        const result = await client.callTool({ name: 'mcp_browser_call', arguments: { name: 'screenshot', arguments: { tabId: 9 } } });
        assert.deepEqual(result.content, [image], 'image blocks reach multimodal MCP clients unchanged');
        const failed = await client.callTool({ name: 'mcp_browser_call', arguments: { name: 'invalid' } });
        assert.equal(failed.isError, true, 'the real server error is not wrapped as success');
      }
    } finally { await client.close(); }
  }
  assert.equal(requests.length, 2, 'no result is retried');
  assert.deepEqual(requests[0].args, { name: 'screenshot', arguments: { tabId: 9 } });

  {
    // The worker relays browser results up to the host's reply limit. A runner reads its
    // stdio link with ASSISTANT_WORKER_READ_LIMIT, which leaves room above that limit for
    // the JSON-RPC envelope and one read chunk, so a reply above the SDK's default arrives
    // intact and the link stays open for the next call. The link is opened the way both
    // runners open it, so a link without the limit fails here.
    assert.ok(ASSISTANT_WORKER_READ_LIMIT >= ASSISTANT_BROWSER_REPLY_LIMIT + 1024 * 1024, 'the read limit covers the largest relayed reply');
    const client = new Client({ name: 'full-browser-large-reply', version: '1.0.0' });
    await client.connect(new StdioClientTransport(assistantWorkerLink(join(process.cwd(), 'dist/assistant-worker.mjs'),
      { TABAI_ASSISTANT_SOCKET: socketPath, TABAI_ASSISTANT_SECRET: 'test-secret', TABAI_ASSISTANT_CHAT: '1', TABAI_ASSISTANT_FULL_ACCESS: '1' })));
    try {
      const large = await client.callTool({ name: 'mcp_browser_call', arguments: { name: 'large_screenshot', arguments: { tabId: 9 } } });
      assert.equal(large.isError, undefined, 'a reply above the default read limit is not refused');
      assert.equal(large.content[0].data.length, largeImage.data.length, 'the image arrives whole');
      const next = await client.callTool({ name: 'mcp_browser_call', arguments: { name: 'screenshot', arguments: { tabId: 9 } } });
      assert.deepEqual(next.content, [image], 'the link still answers after the large reply');
    } finally { await client.close(); }
    assert.equal(requests.length, 4, 'each call reaches the host once');
  }

  const calls = [], tools = [{ name: 'future_tool', inputSchema: { type: 'object', properties: { future: { type: 'string' } } } },
    { name: 'health', inputSchema: { type: 'object' } }, { name: 'tabs_context_mcp', inputSchema: { type: 'object' } }];
  let closed = 0;
  const transport = {
    listTools: async () => ({ tools }),
    callRaw: async (name, args) => {
      calls.push({ name, args });
      if (args.fail) throw new Error('ambiguous timeout');
      return { content: [{ type: 'text', text: JSON.stringify({ name }) }] };
    },
    close: async () => { closed++; },
  };
  const session = new AssistantMcpBrowser(transport, 22);
  assert.deepEqual((await session.tools({ offset: 0, limit: 5 })).tools, tools, 'catalogue and schemas come from the actual connection');
  await assert.rejects(session.call('unknown', {}), /finns inte/);
  await session.call('health', {});
  assert.deepEqual(calls.splice(0), [{ name: 'health', args: {} }], 'diagnostics do not create or require a browser window');
  await session.call('tabs_context_mcp', { createIfEmpty: true });
  await session.call('future_tool', { future: 'value' });
  assert.deepEqual(calls[0], { name: 'tabs_context_mcp', args: { createIfEmpty: true, createWindowId: 22 } });
  assert.deepEqual(calls[1], { name: 'future_tool', args: { future: 'value' } });
  await assert.rejects(session.call('future_tool', { fail: true }), /ambiguous timeout/);
  assert.equal(calls.length, 3, 'ambiguous effects are never retried');
  tools.push({ name: 'new_tool', inputSchema: { type: 'object' } });
  assert.equal((await session.tools({ name: 'new_tool', offset: 0, limit: 5 })).tools[0].name, 'new_tool');

  {
    // The assistant's own server gets the per-user data directory, here a temp directory, as
    // its deny root; an inherited value cannot move it. The substring check on the outer call
    // cannot see a file name a recipe assembles from two parameters, so the server refuses it.
    const dataDir = join(directory, 'assistant'), secret = join(dataDir, 'zoho-mail-oauth.json'), profile = join(dataDir, 'profile.json');
    mkdirSync(dataDir, { recursive: true }); writeFileSync(secret, '{"refreshToken":"fixture"}'); writeFileSync(profile, '{}');
    process.env.CCMCP_UPLOAD_DENY_ROOT = join(directory, 'elsewhere');
    const env = assistantServerEnvironment(dataDir);
    delete process.env.CCMCP_UPLOAD_DENY_ROOT;
    assert.equal(env.CCMCP_UPLOAD_DENY_ROOT, resolve(directory), 'the deny root is the directory that holds the assistant data');
    assert.equal(env.CCMCP_CONFIG_DIR, join(dataDir, 'browser-store'), "the server's own store lies inside the deny root");
    const bridged = [];
    const bridge = { connected: true, pendingCount: 0, configurePanel() {}, activity: () => ({ calls: [] }),
      async call(tool, args) { bridged.push({ tool, args }); return tool === 'health' ? { extVersion: EXTENSION_VERSION } : { ok: true }; } };
    process.env.CCMCP_UPLOAD_DENY_ROOT = env.CCMCP_UPLOAD_DENY_ROOT;
    const server = new McpServer({ name: 'assistant-server', version: '1.0.0' });
    registerCatalog(server, { bridge, recipes: new RecipeStore(join(directory, 'recipes.json'), value => recipeSchema.parse(value)),
      history: new RunHistory(join(directory, 'runs')), workflows: new WorkflowControl(), tempUploads: new Set(), serverVersion: EXTENSION_VERSION });
    delete process.env.CCMCP_UPLOAD_DENY_ROOT;
    const client = new Client({ name: 'assistant-server-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    try {
      const full = new AssistantMcpBrowser({ listTools: () => client.listTools(), callRaw: (name, args) => client.callTool({ name, arguments: args }), close: async () => {} });
      await client.callTool({ name: 'recipe_save', arguments: { name: 'two-part', parameters: { dir: { type: 'string' }, name: { type: 'string' } },
        actions: [{ tool: 'file_upload', args: { tabId: 1, ref: 'ref_1', paths: ['{{dir}}{{name}}'] } }] } });
      for (const [why, name, args] of [
        ['a recipe naming the file in two parts', 'recipe_run', { name: 'two-part', parameters: { dir: `${dataDir}${sep}zoho-mail-`, name: 'oauth.json' } }],
        ['the data directory itself', 'file_upload', { tabId: 1, ref: 'ref_1', paths: [dataDir] }],
        ['the deny root', 'file_upload', { tabId: 1, ref: 'ref_1', paths: [directory] }],
        ['a batch step with another private file', 'browser_batch', { actions: [{ tool: 'file_drop', args: { tabId: 1, ref: 'ref_1', path: profile } }] }],
      ]) {
        const result = await full.call(name, args);
        assert.equal(result.isError, true, `${why} is refused by the server`);
        assert.match(result.content[0].text, /FILE_REFUSED/, why);
      }
      assert.deepEqual(bridged.filter(call => ['file_upload', 'file_drop'].includes(call.tool)), [], 'no private path reached the browser');
    } finally { await client.close(); }
  }

  // The executors run from a root without Tabai's server: a session this test did not preset,
  // after a change in how sessions are keyed, fails here instead of starting the real server.
  const noServerRoot = join(directory, 'no-server-root'); mkdirSync(noServerRoot);
  const executor = new AssistantExecutor(noServerRoot, directory);
  const execution = (enabled, conversationId = 'conversation') => ({
    context: { chat: { conversationId, messages: [], web: { level: 'off', login: false, fullAccess: enabled } }, settings: { accounts: [] }, run: { id: 'run' } },
    callbacks: {}, webGeneration: 0, chatContextRead: true,
  });
  executor.fullBrowser = { conversationId: 'conversation', session };
  await assert.rejects(executor.dispatch(execution(false), 'mcp_browser_call', { name: 'future_tool', arguments: {} }), /avstängd/);
  await executor.dispatch(execution(true), 'mcp_browser_call', { name: 'future_tool', arguments: {} });
  await executor.dispatch(execution(true), 'mcp_browser_call', { name: 'future_tool', arguments: {} });
  assert.equal(calls.filter(call => call.name === 'tabs_context_mcp').length, 1, 'successive turns retain the owned browser');
  await executor.closeWeb('another-conversation'); assert.equal(closed, 0);
  await executor.revokeWeb(); assert.equal(closed, 1);
  await assert.rejects(executor.dispatch(execution(true), 'mcp_browser_call', { name: 'future_tool', arguments: {} }), /ändrades under svaret/);
  await executor.close();
  {
    const mail = new AssistantExecutor(noServerRoot, directory), events = [];
    const run = { context: { settings: { accounts: [], web: { fullAccess: true, level: 'off', login: false } }, run: { id: 'mail-effects' } }, callbacks: {}, webGeneration: 0 };
    mail.fullBrowser = { conversationId: 'run:mail-effects', session: {
      tools: async () => ({ tools: [] }), close: async () => {}, drainActivity: () => [],
      call: async () => { events.push('dispatch'); return { content: [] }; },
    } };
    await mail.dispatch(run, 'mcp_browser_tools', {});
    assert.deepEqual(events, [], 'reading the catalogue does not mark an external action');
    await assert.rejects(mail.dispatch(run, 'mcp_browser_call', { name: 'computer', arguments: {} }), /registreras säkert/);
    assert.deepEqual(events, [], 'a missing persistence hook prevents raw mail dispatch');
    run.callbacks.externalEffect = async () => { throw new Error('fixture persist failure'); };
    await assert.rejects(mail.dispatch(run, 'mcp_browser_call', { name: 'computer', arguments: {} }), /persist failure/);
    assert.deepEqual(events, [], 'failed persistence prevents raw mail dispatch');
    run.callbacks.externalEffect = async () => { events.push('persist'); };
    await mail.dispatch(run, 'mcp_browser_call', { name: 'computer', arguments: {} });
    assert.deepEqual(events, ['persist', 'dispatch'], 'external intent is durable before any raw dispatch');
    mail.fullBrowser.session.call = async () => { events.push('ambiguous dispatch'); throw new Error('ambiguous timeout'); };
    await assert.rejects(mail.dispatch(run, 'mcp_browser_call', { name: 'javascript_tool', arguments: {} }), /ambiguous timeout/);
    assert.deepEqual(events.slice(-2), ['persist', 'ambiguous dispatch']);
    assert.equal(events.filter(event => event === 'ambiguous dispatch').length, 1, 'an ambiguous effect is dispatched once');
    await mail.close();
  }
  {
    const watcher = new AssistantExecutor(noServerRoot, directory);
    const run = { context: { watch: {}, settings: { web: { level: 'off', login: false, fullAccess: true } }, run: { id: 'watch' } }, callbacks: {}, webGeneration: 0 };
    let result = { content: [{ type: 'text', text: '{}' }] };
    watcher.fullBrowser = { conversationId: 'watch:watch', session: { call: async () => result, close: async () => {}, drainActivity: () => [] } };
    await watcher.dispatch(run, 'mcp_browser_call', { name: 'navigate', arguments: {} });
    assert.equal(run.webSucceeded, undefined, 'navigation alone does not certify a watch read');
    await watcher.dispatch(run, 'mcp_browser_call', { name: 'get_page_text', arguments: {} });
    assert(run.webSucceeded.has('web_read'), 'a full MCP observation counts as a watch read');
    result = { isError: true, content: [{ type: 'text', text: 'TIMEOUT: ambiguous result' }] };
    assert.equal((await watcher.dispatch(run, 'mcp_browser_call', { name: 'get_page_text', arguments: {} })).isError, true);
    assert.equal(run.webTimedOut, true, 'raw error metadata reaches the existing watch outcome policy');
    await watcher.close();
  }
  {
    const stopping = new AssistantExecutor(noServerRoot, directory);
    let release;
    stopping.fullBrowser = { conversationId: 'conversation', session: { close: () => new Promise(resolve => { release = resolve; }) } };
    const stop = stopping.stop();
    await assert.rejects(stopping.dispatch(execution(true), 'mcp_browser_call', { name: 'future_tool', arguments: {} }), /ändrades under svaret/,
      'stop revokes before awaiting session shutdown, so no new session can be created');
    release(); await stop; await stopping.close();
  }
  console.log('assistant full browser: opt-in, provider parity, rich worker results, dynamic catalogue, no replay and revocation passed');
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
  rmSync(directory, { recursive: true, force: true });
  stopWatchdog();
}
