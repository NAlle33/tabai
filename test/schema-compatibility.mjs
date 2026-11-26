// Stored documents and schema behaviours an existing installation relies on, read through the
// product's own loaders and schemas. Every expectation here is what the product accepted and
// produced before: the schema library underneath may change only while all of them still hold.
// Two differences are accepted and stated as such: an address is kept without surrounding white
// space, tabs and line breaks, and string lengths count characters (code points) rather than
// UTF-16 units, except where the host saves, cuts or budgets a text by its limit in units.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { watchdog } from './watchdog.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'tabai-schema-compat-'));
const stopWatchdog = watchdog(() => rmSync(dir, { recursive: true, force: true }));
// Nothing below writes logs or stores, but keep any default path away from the user's data.
process.env.CCMCP_CONFIG_DIR = join(dir, 'config');
process.env.CCMCP_LOG_DIR = join(dir, 'logs');

// Loader schemas a module keeps to itself are exported in this test's own bundle only, by
// appending an export to the module's source; the product's modules stay as they are.
const privateSchemas = {
  'src/assistant-controller.ts': ['stateSchema', 'localVerificationsSchema'],
  'src/assistant-conversations.ts': ['stateSchema', 'legacySchema'],
  'src/assistant-watches.ts': ['stateSchema'],
  'src/assistant-routines.ts': ['stateSchema'],
  'src/assistant-profile.ts': ['stateSchema'],
  'src/assistant-mail-methods.ts': ['stateSchema'],
  'src/assistant-files.ts': ['schema'],
  'src/recipe-checkpoints.ts': ['checkpoint'],
  'src/timeout-incidents.ts': ['incident'],
};
const exposePrivate = { name: 'expose-private-schemas', setup(bundle) {
  bundle.onLoad({ filter: /\.ts$/ }, args => {
    const names = privateSchemas[relative(root, args.path).split(sep).join('/')];
    if (!names) return undefined;
    return { contents: `${readFileSync(args.path, 'utf8')}\nexport { ${names.join(', ')} };\n`, loader: 'ts' };
  });
} };
const modules = {
  assistant: './shared/assistant.ts', cases: './shared/assistant-cases.ts', chat: './shared/assistant-chat.ts',
  services: './shared/assistant-services.ts', modules: './shared/personal-modules.ts', workflow: './shared/workflow-schema.ts',
  tools: './src/assistant-tools.ts', controller: './src/assistant-controller.ts', conversations: './src/assistant-conversations.ts',
  watches: './src/assistant-watches.ts', routines: './src/assistant-routines.ts', profile: './src/assistant-profile.ts',
  mailMethods: './src/assistant-mail-methods.ts', files: './src/assistant-files.ts', budget: './src/assistant-budget.ts',
  connections: './src/assistant-connections.ts', checkpoints: './src/recipe-checkpoints.ts', incidents: './src/timeout-incidents.ts',
  personalModules: './src/personal-modules.ts', recipeStore: './src/recipe-store.ts', metadataStore: './src/metadata-store.ts',
};
// Packages stay external, as in the product's own server bundles: the bundle lives in the
// temporary directory, beside a link to the installed packages so its imports resolve.
const bundleDir = join(dir, 'bundle');
mkdirSync(bundleDir);
symlinkSync(join(root, 'node_modules'), join(bundleDir, 'node_modules'), 'junction');
await build({
  stdin: { contents: Object.entries(modules).map(([name, path]) => `export * as ${name} from '${path}';`).join('\n'), resolveDir: root, loader: 'ts' },
  bundle: true, outfile: join(bundleDir, 'schemas.mjs'), platform: 'node', format: 'esm', target: 'node20', packages: 'external', plugins: [exposePrivate], logLevel: 'error',
});
const m = await import(pathToFileURL(join(bundleDir, 'schemas.mjs')).href);
const { RecipeStore } = m.recipeStore, { MetadataStore } = m.metadataStore;
let checked = 0;

/** Writes `value` as a private store file the way the product does, and returns its path. */
function storeFile(name, value) {
  const path = join(dir, 'data', name);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  return path;
}
/** Loads one entry of a keyed store file through the product's RecipeStore and the given schema. */
function loadEntry(name, key, schema, value) {
  const path = storeFile(name, { [key]: value });
  return new RecipeStore(path, input => schema.parse(input)).load()[key];
}
const clone = value => JSON.parse(JSON.stringify(value));
const uuid = n => `3f2b8c1e-9d4a-4b7e-8f21-0c6d5e4a3b${String(n).padStart(2, '0')}`;
const sha = char => char.repeat(64);

try {
  // ---------------------------------------------------------------- stored documents
  const source = { observationId: 'obs-1', quote: 'Kan du skicka offerten i dag?' };
  const finding = {
    accountId: 'work-gmail', threadId: 'gmail:18c2f0a1b2c3d4e5', messageId: '18c2f0a1b2c3d4e9', kind: 'reply',
    title: 'Offert till Exempel AB', summary: 'Kunden vill ha offerten i dag.', reason: 'En direkt fråga till dig.', priority: 1,
    sourceUrl: 'https://mail.google.com/mail/u/0/#inbox/18c2f0a1b2c3d4e5', sender: 'Per Kund <per@example.net>',
    recipient: 'per@example.net', deadline: 'i dag', draft: 'Hej Per,\n\nOfferten kommer i eftermiddag.', sources: [source],
    replyFrom: 'anna.svensson+jobb@example.org',
  };
  const item = { ...finding, id: 'item-1', revision: 3, status: 'open', updatedAt: '2026-11-20T08:15:02.531Z', draftEdited: true, opened: false, autoAttempt: 2 };
  const resolved = { ...finding, id: 'item-2', revision: 5, status: 'resolved', updatedAt: '2026-11-19T16:02:11.000Z', feedback: 'no-reply',
    resolution: { reason: 'Besvarad i tråden.', messageId: '18c2f0a1b2c3d4ea', sourceUrl: 'https://mail.google.com/mail/u/0/#sent/18c2f0a1b2c3d4ea', sources: [source], resolvedAt: '2026-11-19T16:02:10.004Z' },
    sendLocked: true, pendingFinding: { ...finding, threadId: 'gmail:18c2f0a1b2c3d4e5', title: 'Ny fråga i tråden' } };
  const snoozed = { ...finding, id: 'item-3', revision: 1, status: 'snoozed', kind: 'information', priority: 3, snoozedUntil: '2026-11-21T07:00:00.000Z', updatedAt: '2026-11-20T08:15:03.000Z' };
  delete snoozed.draft; delete snoozed.recipient; delete snoozed.replyFrom;
  const help = { accountId: 'zoho-1', message: 'Logga in på Zoho och välj Fortsätt.', code: 'login', sourceUrl: 'https://mail.zoho.eu/zm/#mail/folder/inbox', tabId: 812, reason: 'login-page' };
  const run = {
    id: 'run-20261120-0815', task: 'check-mail', label: 'Kolla mina mejl', model: 'codex:gpt-6.1-terra', externalEffect: 'none', status: 'review',
    message: 'Klart.', summary: 'Två mejl behöver svar.', startedAt: '2026-11-20T08:14:59.123Z', updatedAt: '2026-11-20T08:21:40.870Z',
    // A model wrote these coverage times; one has minute precision, as the worker's schema accepted it.
    coverage: [{ accountId: 'work-gmail', status: 'checked', message: 'Inkorg och skickat lästa.', checkedAt: '2026-11-20T08:20Z' },
      { accountId: 'zoho-1', status: 'login', message: 'Inloggning krävs.' }],
    scanKey: sha('c').slice(0, 64), scanStartedAt: '2026-11-20T08:14:59.123Z', scanId: 'scan-1',
    checkpoints: [{ accountId: 'work-gmail', threadId: 'gmail:18c2f0a1b2c3d4e5', messageId: '18c2f0a1b2c3d4e9', sourceUrl: 'https://mail.google.com/mail/u/0/#inbox/18c2f0a1b2c3d4e5', reviewedAt: '2026-11-20T08:17:00.001Z', outcome: 'needs-action' }],
    activity: { stage: 'complete', message: 'Klar', accountId: 'work-gmail', tabId: 811, updatedAt: '2026-11-20T08:21:40.870Z', reviewedThreads: 6 },
    help, helps: [help], accountProgress: [{ accountId: 'work-gmail', reviewedThreads: 6 }], scheduled: true, learnMail: false, canContinue: false,
  };
  const caseEntry = { id: uuid(1), revision: 4, title: 'Avtal med Exempel AB', status: 'waiting', deadline: '2026-12-01',
    links: [{ kind: 'item', itemId: 'item-1' }, { kind: 'module', moduleId: 'offert', runId: 'run-7' }, { kind: 'url', url: 'https://Example.net/avtal', label: 'Avtalet' }],
    createdAt: '2026-11-18T10:00:00.000Z', updatedAt: '2026-11-20T08:30:00.000Z' };
  const settings = {
    accounts: [{ id: 'work-gmail', provider: 'gmail', label: 'Jobb', email: 'anna.svensson+jobb@example.org', url: 'https://mail.google.com/mail/u/0/#inbox', enabled: true },
      { id: 'zoho-1', provider: 'zoho', label: 'Zoho', email: "o'brien@example.net", url: 'https://mail.zoho.eu/zm/#mail/folder/inbox', enabled: false }],
    lookbackDays: 14, followupDays: 5, timezone: 'Europe/Stockholm', tone: 'Kort och vänlig.', autoAcknowledgements: false,
    acknowledgementRecipients: ['kund@example.com'], acknowledgementBody: 'Tack, jag återkommer.',
    preferences: { shortReplies: true, senderRules: [{ accountId: 'work-gmail', email: 'chef@example.org', priority: 'high' }] },
    morning: { enabled: true, time: '07:30', notifications: true, task: 'my-day' },
    // A saved local choice of a retired model, and the older Codex-only shape of a choice.
    agent: { backend: 'local', codex: { model: 'gpt-6.1-terra', reasoningEffort: 'medium' }, claude: { model: 'claude-opus-5-5', effort: 'medium' }, local: { model: 'qwen3.5:9b-q4_K_M' } },
    chatAgent: { model: 'gpt-6.1-sol', reasoningEffort: 'high' },
    web: { level: 'read', login: false, tasks: 'manual' }, learnMail: true, watchNotifications: false,
  };
  const accountTest = { id: uuid(2), accountId: 'work-gmail', startedAt: '2026-11-17T09:00:00.000Z', updatedAt: '2026-11-17T09:01:30.000Z', status: 'partial', tabId: 900,
    steps: [{ key: 'identity', status: 'passed', message: 'Rätt konto.' }, { key: 'inbox', status: 'passed', message: 'Inkorgen läst.' },
      { key: 'thread', status: 'failed', message: 'Tråden kunde inte läsas.', code: 'THREAD' }, { key: 'sent', status: 'skipped', message: 'Hoppades över.' }] };
  const workspace = {
    revision: 42, settings, items: [item, resolved, snoozed], shortcuts: [{ id: 'weekly', label: 'Veckorapport', instructions: 'Sammanfatta veckan.' }],
    current: { ...run, status: 'running', id: 'run-20261121-0700' }, history: [run],
    lastChecks: { 'work-gmail': '2026-11-20T08:14:59.123Z', 'zoho-1': '2026-11-19T08:00Z' },
    schedule: { nextRunAt: '2026-11-21T06:30:00.000Z', lastRunAt: '2026-11-20T06:30:00.000Z', message: 'Nästa kontroll i morgon.' },
    attention: { count: 2, critical: 1, createdAt: '2026-11-20T08:16:00.000Z' }, cases: [caseEntry], accountTests: [accountTest],
  };
  const state = {
    version: 1, workspace, answers: [{ question: 'Vem är Per?', answer: 'En kund.', accountId: 'work-gmail', threadId: 'gmail:18c2f0a1b2c3d4e5', runId: 'run-1' }],
    sendAttempt: { id: uuid(3), hash: sha('d'), approvedAt: '2026-11-20T08:40:00.000Z', dispatchedAt: '2026-11-20T08:40:01.250Z',
      approval: { itemId: 'item-1', revision: 3, account: settings.accounts[0], threadId: 'gmail:18c2f0a1b2c3d4e5', sourceUrl: finding.sourceUrl, recipient: 'per@example.net', body: 'Hej Per', sender: 'anna.svensson+jobb@example.org' } },
    schedule: { key: 'check-mail:07:30', lastDay: '2026-11-20' }, attentionSeen: { 'item-1': '3' },
    reviews: [{ accountId: 'work-gmail', threadId: 'gmail:18c2f0a1b2c3d4e5', messageId: '18c2f0a1b2c3d4e9', outcome: 'needs-action', reviewedAt: '2026-11-20T08:17:00.001Z', rows: [{ key: 'row-1', version: 'v-9' }] }],
  };
  {
    const loaded = loadEntry('workspace.json', 'state', m.controller.stateSchema, state);
    const expected = clone(state);
    // Defaults a file without these keys gets: the bindings map, a module link's label.
    expected.accountBindings = {};
    expected.workspace.cases[0].links[1].label = '';
    expected.workspace.cases[0].links[2].url = 'https://example.net/avtal';
    expected.workspace.cases[0] = { ...expected.workspace.cases[0], description: '', nextAction: '', waitingFor: '' };
    // A retired local model is read as the current one; the stored choice is otherwise kept.
    expected.workspace.settings.agent.local.model = 'qwen3.5:4b-q4_K_M';
    assert.deepEqual(loaded, expected, 'workspace.json with settings, items, runs, cases and account tests');
    checked++;
  }
  assert.deepEqual(loadEntry(join('archive', 'item-2.json'), 'item', m.assistant.assistantWorkspaceSchema.shape.items.element, resolved), resolved, 'an archived item');
  assert.deepEqual(loadEntry(join('scans', 'scan-1.json'), 'run', m.assistant.assistantRunSchema, run), run, 'a stored scan with help requests');
  checked += 2;

  {
    const message = (n, extra) => ({ id: uuid(10 + n), role: 'assistant', text: `Svar ${n}`, createdAt: `2026-11-20T09:0${n}:00.000Z`, status: 'complete', ...extra });
    const conversation = {
      id: uuid(20), title: 'Elpriser', createdAt: '2026-11-20T09:00:00.000Z', updatedAt: '2026-11-20T09:09:00.000Z',
      context: { kind: 'case', id: uuid(1), revision: 4, label: 'Avtal med Exempel AB' }, moduleTarget: { moduleId: 'offert', runId: 'run-7' },
      messages: [
        { id: uuid(30), role: 'user', text: 'Jämför elpriser', createdAt: '2026-11-20T09:00:00.000Z', status: 'complete',
          files: [{ id: uuid(31), name: 'sida.txt', kind: 'text', size: 2048, received: 2048, status: 'ready', textChars: 1900, source: 'page', pageUrl: 'https://elpris.example.com/idag', pageTruncated: true }] },
        message(1, { model: 'codex:gpt-6.1-terra', task: { id: uuid(32), label: 'Kolla mina mejl', status: 'review', counts: { replies: 1, needsYou: 2, info: 3 } },
          usage: { inputTokens: 1200, outputTokens: 300, costEur: 0.0021 }, continuation: { userId: uuid(30), effect: 'none' } }),
        message(2, { card: { id: uuid(33), title: 'Ny bevakning', detail: 'Elpris under 50 öre', status: 'applied', userMessageId: uuid(30),
          intent: { kind: 'watch', title: 'Elpris', target: { url: 'https://elpris.example.com/idag' }, condition: 'under 50 öre/kWh', cadence: { hours: 6 } } } }),
        message(3, { card: { id: uuid(34), title: 'Ny rutin', detail: 'Varje vardag', status: 'pending',
          intent: { kind: 'routine-create', routine: { kind: 'task', title: 'Morgonkoll', schedule: { time: '07:00', days: [1, 2, 3, 4, 5] }, task: 'check-mail' } } } }),
        message(4, { compare: { query: 'Hörlurar', readAt: '2026-11-20T09:04:00.000Z', rows: [{ shop: 'Butik', product: 'Lurar X', price: 1299.5, shipping: 0, currency: 'SEK', url: 'https://butik.example.com/lurar-x' }] },
          webActivity: ['Läste https://butik.example.com/lurar-x'] }),
        message(5, { lists: [{ kind: 'watches', revision: 'r1', readAt: '2026-11-20T09:05:00.000Z', rows: [{ id: uuid(40), title: 'Elpris', enabled: true, detail: 'Var sjätte timme', at: '2026-11-20T08:00Z' }] }] }),
        message(6, { module: { moduleId: 'offert', runId: 'run-7', title: 'Offert', status: 'review', message: 'Granska',
          verification: { state: 'failed', message: 'Ett fel', issues: ['Pris saknas'] } }, moduleDialogue: true }),
      ],
    };
    const chat = { version: 2, selected: conversation.id, conversations: [conversation],
      memories: [{ id: uuid(50), label: 'Föredrar', value: 'Korta svar', scope: 'general', updatedAt: '2026-11-19T10:00:00.000Z' }],
      scheduleConversationId: conversation.id, watchConversationId: conversation.id };
    const path = storeFile(join('chat', 'chat.json'), { chat });
    const conversations = new m.conversations.AssistantConversations(dirname(path));
    assert.equal(conversations.unavailable, undefined, 'chat.json loads without falling back to a fresh conversation');
    assert.deepEqual(conversations.store.load().chat, chat, 'chat.json with cards, comparisons, lists, files and memories');
    const legacy = { version: 1, id: uuid(60), messages: [{ id: uuid(61), role: 'user', text: 'Hej', createdAt: '2026-11-01T08:00:00.000Z', status: 'complete' }] };
    assert.deepEqual(loadEntry('chat-legacy.json', 'chat', m.conversations.legacySchema, legacy), legacy, 'a first-version chat.json');
    checked += 3;
  }

  {
    const recipes = {
      legacy: [{ tool: 'navigate', args: { url: 'https://example.com', tabId: 5 } }, { tool: 'computer', args: { action: 'left_click', ref: 'ref_3' } }],
      bare: { version: 2, actions: [{ tool: 'tabs_context_mcp', args: { createIfEmpty: true } }] },
      full: { version: 2, description: 'Logga in och sök', parameters: { query: { type: 'string', required: true, description: 'Sökord' }, pages: { type: 'number', default: 2 }, exact: { type: 'boolean', required: false } },
        actions: [{ tool: 'form_input', args: { value: '{{query}}' }, target: { role: 'textbox', name: 'Sök', frameId: 0 },
          expect: { fieldValue: { selector: '#q', value: { $param: 'query' } }, timeoutMs: 5000 } },
        { tool: 'wait_for', args: { selector: '.result' }, target: { selector: '.result' }, expect: { selector: '.result', state: 'visible', stableForMs: 200 } }] },
    };
    const path = storeFile(join('config', 'recipes.json'), recipes);
    const loaded = new RecipeStore(path, value => m.workflow.recipeSchema.parse(value)).load();
    assert.deepEqual({ ...loaded }, { ...recipes, bare: { ...recipes.bare, parameters: {} } }, 'recipes.json: a legacy recipe, a bare one and one with parameters');
    checked++;
  }

  {
    // The panel's helper stores: recipe checkpoints and timeout incidents.
    const checkpoints = [
      { resumeId: uuid(70), name: 'Logga in', fingerprint: sha('a'), createdAt: '2026-11-20T10:00:00.000Z', updatedAt: '2026-11-20T10:01:00.000Z', cursor: 2, totalSteps: 5, urlHash: sha('b'), phase: 'verified', owner: { pid: 4242, host: 'datorn', token: uuid(71) } },
      { resumeId: uuid(72), name: 'Sök', fingerprint: sha('c'), createdAt: '2026-11-20T11:00:00.000Z', updatedAt: '2026-11-20T11:00:00.000Z', cursor: 0, totalSteps: 1, phase: 'new' },
    ];
    storeFile(join('helpers', 'recipe-checkpoints.json'), { version: 1, records: checkpoints });
    assert.deepEqual(new MetadataStore(join(dir, 'data', 'helpers'), 'recipe-checkpoints', m.checkpoints.checkpoint, 100).read(), checkpoints, 'recipe-checkpoints.json');
    const operation = { id: 7, operation: 'tool.execute', tabId: 812, startedAt: 1763633000000, durationMs: 30001.5, status: 'overdue', errorCode: 'TIMEOUT' };
    const incident = { incidentId: uuid(73), capturedAt: '2026-11-20T10:05:00.000Z', tool: 'wait_for', durationMs: 32000, timeoutMs: 30000,
      serverBuildId: `sha256:${sha('e')}`, brokerBuildId: 'unbundled', diagnosticsAvailable: true,
      operations: { active: [{ ...operation, note: 'dropped on read' }], recent: [], dropped: 0, degraded: false } };
    storeFile(join('helpers', 'timeout-incidents.json'), { version: 1, records: [incident] });
    const expected = clone(incident); delete expected.operations.active[0].note;
    assert.deepEqual(new MetadataStore(join(dir, 'data', 'helpers'), 'timeout-incidents', m.incidents.incident, 50).read(), [expected], 'timeout-incidents.json, with an unknown field stripped');
    checked += 2;
  }

  {
    const watch = { id: uuid(80), title: 'Elpris', target: { url: 'https://elpris.example.com/idag' }, condition: 'under 50 öre/kWh', cadence: { time: '07:15' }, enabled: true,
      createdAt: '2026-11-10T07:00:00.000Z', createdFrom: uuid(33), lastRunAt: '2026-11-20T07:15:04.000Z',
      lastResult: { changed: true, summary: 'Priset är 48 öre/kWh.', at: '2026-11-20T07:15:30.000Z', status: 'ok', value: { amount: 48, unit: 'öre/kWh' } },
      history: [{ changed: false, summary: 'Ingen ändring.', at: '2026-11-19T07:15:30Z', status: 'failed', failure: 'run' }], failedRuns: 1 };
    const search = { id: uuid(81), title: 'Nyheter', target: { query: 'elpris prognos' }, condition: 'ny prognos', cadence: { hours: 12 }, enabled: false, createdAt: '2026-11-11T07:00:00.000Z', pausedAfterFailures: true };
    const watches = { version: 1, watches: [watch, search] };
    assert.deepEqual(loadEntry('watches.json', 'state', m.watches.stateSchema, watches), watches, 'watches.json');
    const routines = { version: 1, routines: [
      { kind: 'chat', id: uuid(82), title: 'Veckans väder', schedule: { time: '08:00', days: [5] }, prompt: 'Hur blir vädret i helgen?', enabled: true, createdAt: '2026-11-12T08:00:00.000Z', lastRunAt: '2026-11-14T08:00:02.000Z',
        lastResult: { at: '2026-11-14T08:01:00.000Z', status: 'ok', summary: 'Soligt.' } },
      { kind: 'task', id: uuid(83), title: 'Morgonkoll', schedule: { time: '07:00' }, task: 'shortcut', shortcutId: 'weekly', enabled: true, createdAt: '2026-11-12T08:00:00.000Z', createdFrom: uuid(34), failedRuns: 2,
        lastResult: { at: '2026-11-20T07:01:00.000Z', status: 'failed', summary: 'Avbröts.', failure: 'interrupted', taskId: 'run-1' } }] };
    assert.deepEqual(loadEntry('routines.json', 'state', m.routines.stateSchema, routines), routines, 'routines.json');
    const profile = { version: 1, profile: { name: 'Anna Svensson', street: 'Storgatan 1', postalCode: '111 22', city: 'Stockholm', country: 'Sverige', phone: '+46 70 123 45 67',
      email: 'anna@example.org', extra: [{ label: 'Företag', value: 'Exempel AB' }], updatedAt: '2026-11-15T12:00:00.000Z' } };
    assert.deepEqual(loadEntry('profile.json', 'state', m.profile.stateSchema, profile), profile, 'profile.json');
    const version = { id: uuid(84), definition: { steps: ['verify-account', 'read-incoming', 'read-sent', 'return-inbox'], expandThreads: true }, createdAt: '2026-11-16T08:00:00.000Z', verifiedAt: '2026-11-16T08:05:00.000Z' };
    const methods = { version: 1, records: [{ accountId: 'work-gmail', fingerprint: sha('f'), revision: 3, active: version, candidate: { ...version, id: uuid(85) },
      history: [{ at: '2026-11-16T08:05:00.000Z', status: 'verified', mode: 'method', preparationCalls: 4, preparationMs: 5100, folders: 2, reviewedThreads: 9, inputTokens: 1000, outputTokens: 200, costEur: 0.01 }] }] };
    assert.deepEqual(loadEntry('mail-methods.json', 'state', m.mailMethods.stateSchema, methods), methods, 'mail-methods.json');
    const files = { version: 1, files: [{ id: uuid(31), name: 'sida.txt', kind: 'text', size: 2048, received: 2048, status: 'ready', textChars: 1900, source: 'page', pageUrl: 'https://elpris.example.com/idag', conversationId: uuid(20), createdAt: '2026-11-20T09:00:00.000Z' },
      { id: uuid(86), name: 'kvitto.png', kind: 'image', size: 4096, received: 4096, status: 'ready', ocr: true, preview: 'Kvitto', conversationId: uuid(20), createdAt: '2026-11-20T09:01:00.000Z', host: true }] };
    assert.deepEqual(loadEntry(join('attachments', 'files.json'), 'state', m.files.schema, files), files, 'attachments/files.json');
    checked += 5;
  }

  {
    // Stores that read their own file rather than through RecipeStore, each through that read
    // path: private in TypeScript, so reachable from this test only.
    const price = { model: 'fixture-model', currency: 'EUR', inputPerMillion: 1, outputPerMillion: 2, checkedAt: '2026-11-20T09:00:00.000Z', source: 'https://api.berget.ai/v1/models/' };
    const ledger = { version: 1, limitEur: 5, entries: [{ id: uuid(90), model: 'fixture-model', runId: 'run-1', createdAt: '2026-11-20T09:00:01.000Z', status: 'settled', reservedEur: 0.01, costEur: 0.002, inputTokens: 100, outputTokens: 50, price, period: '2026-11', ownerPid: 4242 }] };
    const budgetFile = storeFile(join('budget', 'assistant-budget.json'), ledger);
    assert.deepEqual(new m.budget.AssistantBudget(dirname(budgetFile)).read(), { ...ledger, message: '' }, 'assistant-budget.json from before its message, read with an empty one');
    const connections = { version: 1, records: [{ id: 'codex', label: 'Codex', state: 'ready', configured: true, testedAt: '2026-11-18T08:00:00.000Z', model: 'gpt-6.1-terra', message: 'Klar', runtimeVersion: '1.2.3' },
      { id: 'local', label: 'Lokal modell', state: 'action-required', configured: false, message: 'Starta Ollama', catalogOnly: true }] };
    const connectionsFile = storeFile(join('connections', 'assistant-connections.json'), connections);
    assert.deepEqual(new m.connections.AssistantConnections(root, dirname(connectionsFile)).records(), connections.records, 'assistant-connections.json');
    const registry = [{ id: 'offert', command: resolve(root, 'bin', 'offert'), args: ['--serve'], cwd: root }];
    const registryFile = storeFile(join('modules-config', 'personal-modules.json'), registry);
    assert.deepEqual(new m.personalModules.PersonalModules(dirname(registryFile)).load(), registry, 'personal-modules.json');
    // Protocol self-tests of local models: a retired model's entry is read and set aside.
    const verification = (model, digest, extra = {}) => ({ model, digest: sha(digest), ollamaVersion: '0.12.3', profile: 'intent', verifiedAt: '2026-11-18T10:00:00.000Z', ...extra });
    const verifications = [verification('qwen3.5:4b-q4_K_M', 'a'), verification('qwen3.5:9b-q4_K_M', 'b'), verification('qwen3.5:2b-q4_K_M', 'c', { profile: 'native', verifiedAt: '2026-11-17T10:00Z' })];
    assert.deepEqual(loadEntry('local-models.json', 'verifications', m.controller.localVerificationsSchema, verifications), [verifications[0]], 'local-models.json, retired models set aside');
    checked += 4;
  }

  {
    // A module program's own view: its identifiers and times are the module's, not Tabai's.
    const view = { title: 'Offert', description: 'Skapar offerter.', startLabel: 'Starta', fields: [{ name: 'kund', label: 'Kund', required: true }, { name: 'lank', label: 'Länk' }],
      run: { id: 'run-7', status: 'review', message: 'Granska', updatedAt: '2026-11-20T09:30Z', replyReceivedAt: '2026-11-20T09:29:59Z',
        sources: [{ label: 'Prislista', url: 'https://example.net/priser' }],
        conversation: [{ id: '11111111-1111-1111-1111-111111111111', role: 'owner', text: 'Lägg till frakt.', at: '2026-11-20T09:20Z' },
          { id: '2c5ea4c0-4067-11e9-8bad-9b1deb4d3b7d', role: 'agent', text: 'Klart.', at: '2026-11-20T09:21:00.000Z' }],
        review: { title: 'Offert', summary: 'Klar', verification: { state: 'passed', message: 'Ok', checkedAt: '2026-11-20T09:31Z', issues: [] }, sections: [] } },
      drafts: { start: { context: 'ny', revision: 1, values: { kund: 'Exempel AB' }, updatedAt: '2026-11-20T09:00Z' } },
      mailStart: { label: 'Gör offert', mailField: 'kund', linkField: 'lank' },
      mailRuns: [{ link: 'https://mail.google.com/mail/u/0/#inbox/18c2f0a1b2c3d4e5', runId: 'run-7', label: 'Offert', handled: true, handledAt: '2026-11-20T09:40Z' }] };
    assert.deepEqual(m.modules.moduleViewSchema.parse(clone(view)), view, "a module's view with its own identifiers and minute-precision times");
    // A start keyword of two UTF-16 units, such as one emoji, was accepted and still is; one unit is not.
    const withKeywords = keywords => ({ ...clone(view), mailStart: { ...view.mailStart, keywords } });
    assert.ok(m.modules.moduleViewSchema.safeParse(withKeywords(['📄', 'offert'])).success, 'a one-emoji keyword');
    assert.equal(m.modules.moduleViewSchema.safeParse(withKeywords(['a'])).success, false, 'a one-letter keyword');
    checked += 3;
  }

  // ---------------------------------------------------------------- behaviours
  const accepts = (schema, value) => schema.safeParse(value).success;
  const parsed = (schema, value) => schema.parse(value);
  const issueMessages = (schema, value) => { const result = schema.safeParse(value); assert.equal(result.success, false, JSON.stringify(value)); return result.error.issues.map(issue => issue.message); };

  // Identifiers: any 8-4-4-4-12 hexadecimal form, without checking UUID version or variant digits.
  const id = m.cases.assistantCaseSchema.shape.id;
  for (const value of ['3f2b8c1e-9d4a-4b7e-8f21-0c6d5e4a3b2c', '3F2B8C1E-9D4A-4B7E-8F21-0C6D5E4A3B2C', '00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff',
    '11111111-1111-1111-1111-111111111111', '3f2b8c1e-9d4a-0b7e-8f21-0c6d5e4a3b2c', '3f2b8c1e-9d4a-4b7e-0f21-0c6d5e4a3b2c', '3f2b8c1e-9d4a-9b7e-cf21-0c6d5e4a3b2c']) {
    assert.equal(parsed(id, value), value, `identifier ${value} is accepted as it is`); checked++;
  }
  for (const value of ['3f2b8c1e9d4a4b7e8f210c6d5e4a3b2c', '{3f2b8c1e-9d4a-4b7e-8f21-0c6d5e4a3b2c}', '3f2b8c1e-9d4a-4b7e-8f21-0c6d5e4a3b2', 'g3f2b8c1-9d4a-4b7e-8f21-0c6d5e4a3b2c', 'not-a-uuid', '']) {
    assert.equal(accepts(id, value), false, `identifier ${value} is refused`); checked++;
  }

  // Times: UTC with Z, seconds and fractions optional; real calendar dates only.
  const at = m.cases.assistantCaseSchema.shape.createdAt;
  for (const value of ['2026-11-26T09:53:46.173Z', '2026-11-26T09:53:46Z', '2026-11-26T09:53Z', '2026-11-26T09:53:46.123456789Z', '2024-02-29T00:00:00Z', '2026-12-31T23:59:59.999Z']) {
    assert.equal(parsed(at, value), value, `time ${value} is accepted as it is`); checked++;
  }
  for (const value of ['2026-11-26T09Z', '2026-11-26T09:53:46+01:00', '2026-11-26T09:53:46', '2026-02-30T00:00:00Z', '2025-02-29T00:00:00Z', '2026-11-26 09:53:46Z',
    '2026-11-26', '2026-11-26T24:00:00Z', '2026-11-26T09:53:60Z', '+002026-11-26T09:53:46Z', '2026-11-26t09:53:46z', '']) {
    assert.equal(accepts(at, value), false, `time ${value} is refused`); checked++;
  }

  // Addresses checked by the URL parser: any scheme it accepts. An address is kept as written,
  // except that surrounding white space is trimmed and tabs and line breaks inside it are
  // removed; the parser itself ignores those. A surrounding no-break space or byte-order mark is
  // trimmed too, which the parser does not ignore: such an address was refused before zod 4 and
  // is now accepted without them.
  const url = m.assistant.assistantAccountSchema.shape.url;
  for (const value of ['https://example.com', 'http://localhost:9223/x?y=1#z', 'https://example.net/väg?q=å', 'mailto:a@b.example', 'about:blank', 'file:///tmp/a.txt',
    'chrome://extensions', 'https://user:pw@example.com', 'data:text/plain,hi', 'HTTPS://Example.COM/A']) {
    assert.equal(parsed(url, value), value, `address ${value} is accepted as it is`); checked++;
  }
  for (const [value, kept] of [[' https://example.com ', 'https://example.com'], ['\u00a0https://example.com/a\ufeff', 'https://example.com/a'],
    ['https://exa\tmple.com/a\nb\r', 'https://example.com/ab'], ['\thttps://example.com/x\n', 'https://example.com/x']]) {
    assert.equal(parsed(url, value), kept, `address ${JSON.stringify(value)} is kept without its surrounding white space, tabs and line breaks`); checked++;
  }
  for (const value of ['example.com', 'https://exa mple.com', 'https://', '//example.com', '']) {
    assert.equal(accepts(url, value), false, `address ${value} is refused`); checked++;
  }

  // String lengths in characters (code points), as the listed maxLength means: a text over a
  // limit in UTF-16 units but within it in characters is accepted, one character more is not.
  assert.equal(parsed(m.cases.assistantCaseSchema.shape.title, '🙂'.repeat(200)).length, 400, 'a case title of 200 characters fits its limit of 200');
  assert.equal(accepts(m.cases.assistantCaseSchema.shape.title, '🙂'.repeat(201)), false, 'one character more does not');
  checked += 2;
  // Except where the host saves, cuts or budgets the same text by that number in UTF-16 units:
  // there the limit counts units, as before zod 4, so a text the host would cut is refused.
  const workerTools = m.tools.assistantToolSchemas, emoji = count => '😀'.repeat(count);
  for (const [label, schema, max] of [
    ['a chat reply', workerTools.chat_reply.shape.text, 16_000],
    ['a question to the user', workerTools.workflow_question.shape.question, 4_000],
    ["a watch's summary", workerTools.watch_report.shape.summary, 2_000],
    ["an account's coverage message", m.assistant.assistantCoverageSchema.shape.message, 2_000],
    ["a task's summary", m.assistant.assistantResultSchema.shape.summary, 12_000],
    // A start refuses longer instructions, so a shortcut that saved could never be started.
    ["a shortcut's instructions", m.assistant.assistantShortcutSchema.shape.instructions, 12_000],
  ]) {
    assert.equal(parsed(schema, emoji(max / 2)).length, max, `${label} of ${max} UTF-16 units fits`);
    assert.equal(accepts(schema, `${emoji(max / 2)}x`), false, `${label} of ${max + 1} UTF-16 units is refused, not cut`);
    checked += 2;
  }

  // E-mail addresses.
  const email = m.assistant.assistantAccountSchema.shape.email;
  for (const value of ['a@b.example', 'first.last+tag@sub.example.com', "o'brien@x.example", 'A@B.EXAMPLE', 'a_b-c@x-y.example.org']) {
    assert.equal(parsed(email, value), value, `e-mail ${value} is accepted`); checked++;
  }
  for (const value of ['a@b', 'a@localhost', 'åäö@example.net', 'a@exämple.example', '"quoted"@x.example', 'a..b@x.example', '.a@x.example', 'a.@x.example', 'a@[127.0.0.1]', 'a@b.c', 'a@-b.example', 'a b@x.example', 'a@x.example ', '']) {
    assert.equal(accepts(email, value), false, `e-mail ${value} is refused`); checked++;
  }

  // Strict objects refuse unknown keys; the others drop them.
  const unknownKey = (schema, value) => { const result = schema.safeParse(value); return !result.success && result.error.issues.some(issue => issue.code === 'unrecognized_keys'); };
  assert.ok(unknownKey(m.cases.assistantCaseSchema, { ...caseEntry, extra: 1 }), 'a case with an unknown key');
  assert.ok(unknownKey(m.assistant.assistantWorkspaceSchema.shape.items.element, { ...item, extra: 1 }), 'an item with an unknown key');
  assert.ok(unknownKey(m.controller.stateSchema, { ...state, extra: 1 }), 'workspace.json with an unknown key');
  assert.ok(unknownKey(m.tools.assistantToolSchemas.chat_config, { extra: 1 }), 'a worker tool argument with an unknown key');
  assert.deepEqual(parsed(m.assistant.assistantWorkspaceSchema.shape.itemPage, { offset: 0, total: 3, extra: 1 }), { offset: 0, total: 3 }, 'a plain object drops an unknown key');
  checked += 5;

  // Defaults fill missing keys; optional keys stay absent.
  const tools = m.tools.assistantToolSchemas;
  assert.deepEqual(parsed(tools.mcp_browser_tools, {}), { offset: 0, limit: 5 });
  assert.deepEqual(parsed(tools.mcp_browser_call, { name: 'screenshot' }), { name: 'screenshot', arguments: {} });
  assert.deepEqual(parsed(tools.workflow_items, {}), { offset: 0, limit: 20 });
  assert.deepEqual(parsed(tools.web_read, { tabId: 3 }), { tabId: 3, offset: 0 });
  assert.deepEqual(parsed(tools.chat_files, { action: 'list' }), { action: 'list', offset: 0, limit: 8000 });
  assert.deepEqual(parsed(m.workflow.recipeSchema, { version: 2, actions: [{ tool: 'navigate' }] }), { version: 2, actions: [{ tool: 'navigate' }], parameters: {} });
  const bareCase = parsed(m.cases.assistantCaseSchema, { id: uuid(1), revision: 0, title: 'Nytt', status: 'open', links: [], createdAt: '2026-11-20T08:00:00.000Z', updatedAt: '2026-11-20T08:00:00.000Z' });
  assert.deepEqual(bareCase, { id: uuid(1), revision: 0, title: 'Nytt', description: '', status: 'open', nextAction: '', waitingFor: '', links: [], createdAt: '2026-11-20T08:00:00.000Z', updatedAt: '2026-11-20T08:00:00.000Z' });
  assert.equal(Object.hasOwn(bareCase, 'deadline'), false, 'an optional key stays absent');
  assert.deepEqual(parsed(tools.mcp_browser_tools, { offset: undefined, limit: 2 }), { offset: 0, limit: 2 }, 'an undefined value takes the default');
  checked += 9;

  // Number bounds the schemas declare.
  for (const [value, ok] of [[0, false], [1, true], [10, true], [11, false], [1.5, false], ['5', false]]) { assert.equal(accepts(tools.mcp_browser_tools, { limit: value }), ok, `limit ${value}`); checked++; }
  for (const [value, ok] of [[-1, false], [0, true], [2_000_000, true], [2_000_001, false]]) { assert.equal(accepts(tools.web_read, { tabId: 1, offset: value }), ok, `offset ${value}`); checked++; }
  for (const [value, ok] of [[0, false], [1, true], [-3, false], [2.5, false]]) { assert.equal(accepts(tools.browser_read, { tabId: value }), ok, `tabId ${value}`); checked++; }
  for (const [value, ok] of [[Number.MAX_SAFE_INTEGER, true], [Number.MAX_SAFE_INTEGER + 1, false], [-1, false]]) { assert.equal(accepts(m.cases.assistantCaseSchema, { ...bareCase, revision: value }), ok, `case revision ${value}`); checked++; }

  // The product's own messages, which reach the model or the panel.
  const row = { shop: 'Butik', product: 'Lurar', price: 499, currency: 'SEK', url: 'https://butik.example.com/x' };
  const compare = rows => ({ query: 'Lurar', rows });
  assert.deepEqual(issueMessages(tools.chat_compare, compare([{ ...row, price: '499 kr' }])), ['Ange priset som ett tal, till exempel 499 eller 1299.5.']);
  assert.deepEqual(issueMessages(tools.chat_compare, compare([{ ...row, shipping: '49' }])), ['Ange frakten som ett tal, till exempel 499 eller 1299.5.']);
  assert.deepEqual(issueMessages(tools.chat_compare, compare([{ ...row, price: -1 }])), ['Priset kan inte vara negativt.']);
  assert.deepEqual(issueMessages(tools.chat_compare, compare([{ ...row, price: 100_000_001 }])), ['Priset är orimligt stort. Kontrollera det på sidan.']);
  assert.deepEqual(issueMessages(tools.chat_compare, compare([{ ...row, currency: 'kr' }])), ['Ange valutan som en kod med tre stora bokstäver, till exempel SEK för kronor.']);
  assert.deepEqual(issueMessages(tools.chat_compare, compare(Array(9).fill(row))), ['Högst 8 butiker i en jämförelse.']);
  assert.deepEqual(issueMessages(m.cases.assistantCaseLinkSchema, { kind: 'url', url: 'ftp://example.net/fil' }), ['Ange en giltig http- eller https-adress utan inloggningsuppgifter.']);
  assert.deepEqual(issueMessages(m.cases.assistantCaseSchema, { ...bareCase, deadline: '2026-02-30' }), ['Ange ett giltigt datum som ÅÅÅÅ-MM-DD.']);
  assert.deepEqual(parsed(tools.chat_compare, compare([row])), compare([row]), 'a valid comparison is kept as it is');
  checked += 9;

  // Unions, records and checks across fields.
  assert.equal(accepts(m.cases.assistantCaseLinkSchema, { kind: 'other', itemId: 'x' }), false, 'an unknown link kind');
  assert.equal(accepts(m.services.assistantRoutineSchema, { kind: 'chat', id: uuid(82), title: 'Väder', schedule: { time: '08:00' }, enabled: true, createdAt: '2026-11-12T08:00:00.000Z' }), false, 'a chat routine without its prompt');
  assert.equal(accepts(m.workflow.parametersSchema, { 'Bad name': { type: 'string' } }), false, 'a parameter name with a space');
  assert.equal(accepts(m.workflow.parametersSchema, { pages: { type: 'number', default: 'two' } }), false, 'a default of the wrong type');
  assert.equal(accepts(m.workflow.expectationSchema, { selector: '#a', text: 'b' }), false, 'an expectation with two criteria');
  assert.equal(accepts(m.assistant.assistantWorkspaceSchema.shape.lastChecks, { 'work-gmail': 'i går' }), false, 'a last-check time that is not a time');
  assert.equal(accepts(m.modules.moduleInputSchema, Object.fromEntries(Array.from({ length: 31 }, (_, n) => [`f${n}`, 'x']))), false, 'more than 30 module input fields');
  assert.equal(accepts(m.controller.stateSchema, { ...state, accountBindings: { 'work-gmail': { provider: 'gmail' } } }), false, 'an account binding without its address');
  assert.deepEqual(parsed(m.controller.stateSchema, { ...state, accountBindings: { 'work-gmail': { provider: 'gmail', email: 'anna@example.org' } } }).accountBindings, { 'work-gmail': { provider: 'gmail', email: 'anna@example.org' } });
  {
    const bad = { version: 2, selected: uuid(99), conversations: [{ id: uuid(20), title: 'x', createdAt: '2026-11-20T09:00:00.000Z', updatedAt: '2026-11-20T09:00:00.000Z', messages: [] }], memories: [] };
    const path = storeFile(join('chat-bad', 'chat.json'), { chat: bad });
    assert.ok(new m.conversations.AssistantConversations(dirname(path)).unavailable, 'a chat.json whose selection names no conversation is set aside');
  }
  checked += 10;

  console.log(`schema-compatibility: ${checked} stored-document and schema-behaviour checks PASS`);
} finally {
  rmSync(dir, { recursive: true, force: true });
  stopWatchdog();
}
