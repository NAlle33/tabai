// The model trial in the CI harness's own Chromium: real chat turns and watch
// runs through AssistantExecutor for each chosen backend, against loopback
// fixture pages (and, with --online, one real web search). Started only by
// `npm run trial` (scripts/assistant-trial.mjs) through
// `test/ci-harness.mjs --suite assistant-trial-live.mjs -- <config.json>`;
// never part of the default live run. A task a backend fails is a result, not
// an error: this suite fails only when the trial itself cannot run.
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssistantExecutor } from '../dist/assistant-agent.mjs';
import { assistantWatchesForChat } from '../dist/assistant-watches.mjs';
import { assistantDuplicateProposal } from '../dist/assistant-chat.mjs';
import { ASSISTANT_WEB_BING_URL, ASSISTANT_WEB_SEARCH_URL } from '../dist/assistant-web.mjs';
import { TRIAL_TIMEZONE, runTrialTurn, trialChatConfig, trialContext, trialFixturePage, trialMailFixture, trialOfflineUrl, trialOrderPage, trialResult, trialSeconds, trialTasks } from '../scripts/assistant-trial-tasks.mjs';
import { attachFixtureMailbox } from './helpers/fixture-mailbox.mjs';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
let orders = 0;
const server = http.createServer((request, response) => {
  const url = new URL(request.url, base);
  response.setHeader('content-type', 'text/html; charset=utf-8');
  if (request.method === 'POST' && url.pathname === '/order') { orders++; response.end(trialOrderPage()); return; }
  const html = request.method === 'GET' ? trialFixturePage(url.pathname, base) : undefined;
  if (html === undefined) response.statusCode = 404;
  response.end(html ?? '<!doctype html><title>Saknas</title>');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

/**
 * Trial-only web options on the real executor: loopback fixtures are allowed,
 * offline navigation stays on them, and a watch may use a normal window,
 * because this launched browser has not allowed Tabai in incognito.
 */
function routeTrialWeb(executor, online) {
  const webSession = executor.webSession.bind(executor), routed = new WeakSet();
  executor.webSession = async (key, access, windowId, options = {}) => {
    const session = await webSession(key, access, windowId, online ? options : { ...options, allowLocal: true, ...(options.strictIncognito ? { strictIncognito: false } : {}) });
    if (!online && !routed.has(session)) {
      routed.add(session);
      const inner = session.transport;
      session.transport = {
        call: (name, args = {}) => inner.call(name, name === 'navigate' ? { ...args, url: trialOfflineUrl(String(args.url), base, [ASSISTANT_WEB_SEARCH_URL, ASSISTANT_WEB_BING_URL]) } : args),
        close: () => inner.close(),
      };
    }
    return session;
  };
}

const tasks = trialTasks(base).filter(task => config.tasks.includes(task.id));
const results = [];
const save = () => writeFileSync(config.resultsPath, JSON.stringify(results, null, 2), { mode: 0o600 });
try {
  for (const backend of config.backends) {
    for (const task of tasks) {
      const turns = [];
      for (const turn of task.turns) {
        // Berget's key and monthly budget live in the user's own assistant folder; every other backend gets a fresh one.
        const dataDir = backend.kind === 'berget' ? config.assistantDir : mkdtempSync(join(tmpdir(), 'tabai-trial-'));
        const executor = new AssistantExecutor(process.cwd(), dataDir);
        routeTrialWeb(executor, !!task.online);
        if (turn.kind === 'mail') {
          const fixture = trialMailFixture(), dispatch = executor.dispatch.bind(executor);
          let attached = false;
          // Replace only the mailbox transport. Model, worker, evidence and coverage checks are real.
          executor.dispatch = async (execution, tool, args) => {
            if (!attached) {
              attachFixtureMailbox(execution.browser, fixture.account, fixture.threads, {
                rows: (row, thread) => thread.legacy === 'ee05' ? { ...row, at: undefined } : row,
              });
              attached = true;
            }
            return dispatch(execution, tool, args);
          };
        }
        const { record, reply } = await runTrialTurn({ executor, context: trialContext(turn, backend, config.localVerifications),
          chatConfig: trialChatConfig(turn, backend, assistantWatchesForChat(task.watches ?? [], TRIAL_TIMEZONE)), orders: () => orders, keepErrors: !task.online,
          // The host's own refusal of a card that copies a saved watch, as in the panel.
          refuseProposal: intent => assistantDuplicateProposal(intent, task.watches ?? []) });
        if (backend.kind !== 'berget') rmSync(dataDir, { recursive: true, force: true });
        turns.push({ turn, record, reply });
      }
      const result = trialResult(backend, task, turns, { base });
      results.push(result); save();
      console.log(`${backend.label} ${task.id}: ${result.pass ? 'godkänd' : 'underkänd'} på ${trialSeconds(result.seconds)} (${result.checks.map(item => `${item.ok ? '✓' : '✗'} ${item.name}`).join(', ')})`);
    }
  }
  save();
} finally {
  server.closeAllConnections(); server.close();
}
// Every executor is closed; a lingering client handle must not hold the harness until its watchdog.
process.exit(0);
