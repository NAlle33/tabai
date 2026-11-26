// The model trial without a browser or a model: its arguments, the choice of
// backends, offline routing, the fixture pages, and a scripted stand-in for the
// executor whose turns are recorded, scored and tabulated. The trial itself
// (real model calls) never runs in npm test or CI.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TRIAL_BERGET_MODEL, TRIAL_CLAUDE, TRIAL_CODEX, TRIAL_FIXTURE, formatTrialTable, parseTrialArgs, runTrialTurn, selectTrialBackends,
  trialChatConfig, trialContext, trialFixturePage, trialMailFixture, trialOfflineUrl, trialResult, trialSeconds, trialTasks, trialToolLine, trialWatchViews,
} from '../scripts/assistant-trial-tasks.mjs';
import { watchdog } from './watchdog.mjs';

const stopWatchdog = watchdog();
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const base = 'http://127.0.0.1:43210', fixture = { base };

// Arguments: offline A–D and F by default; E only with --online.
assert.deepEqual(parseTrialArgs([]), { backends: undefined, tasks: ['A', 'B', 'C', 'D', 'F'], online: false, headed: false, help: false });
assert.deepEqual(parseTrialArgs(['--online']).tasks, ['A', 'B', 'C', 'D', 'E', 'F']);
assert.deepEqual(parseTrialArgs(['--backend', 'codex,claude,local:qwen3.5:4b-q4_K_M,berget', '--online']).backends, ['codex', 'claude', 'local:qwen3.5:4b-q4_K_M', 'berget']);
assert.deepEqual(parseTrialArgs(['--backend=codex,codex', '--task=e', '--online']), { backends: ['codex'], tasks: ['E'], online: true, headed: false, help: false });
assert.throws(() => parseTrialArgs(['--task', 'E']), /kräver --online/, 'a real web search is never implied');
assert.throws(() => parseTrialArgs(['--backend', 'gpt']), /Okänd modell/);
assert.throws(() => parseTrialArgs(['--task', 'G']), /Okänd uppgift/);
assert.throws(() => parseTrialArgs(['--backend']), /kräver ett värde/);
assert.throws(() => parseTrialArgs(['--backend', '--online']), /kräver ett värde/);
assert.throws(() => parseTrialArgs(['--fast']), /Okänt argument/);

// Backends: what the computer has runs; everything else is listed with its reason.
const local = [{ id: 'qwen3.5:4b-q4_K_M', label: 'Qwen3.5 4B', ok: true }];
const found = { codex: { ok: true, version: 'codex-cli 1' }, claude: { ok: false, reason: 'Claude Code CLI svarar inte.' }, berget: { ok: false, reason: 'Ingen Berget-nyckel är sparad i inställningarna.' }, local };
const all = selectTrialBackends(undefined, found);
assert.deepEqual(all.selected.map(backend => backend.id), ['codex', 'local:qwen3.5:4b-q4_K_M']);
assert.deepEqual(all.skipped.map(backend => [backend.id, backend.reason]), [['claude', 'Claude Code CLI svarar inte.'], ['berget', 'Ingen Berget-nyckel är sparad i inställningarna.']]);
assert.deepEqual(all.selected[0].agent, { backend: 'codex', codex: TRIAL_CODEX, claude: TRIAL_CLAUDE, berget: { model: TRIAL_BERGET_MODEL } });
assert.deepEqual(all.selected[1].agent.local, { model: 'qwen3.5:4b-q4_K_M' }); assert.equal(all.selected[1].label, 'Lokal Qwen3.5 4B');
const asked = selectTrialBackends(['local:qwen3.5:4b-q4_K_M', 'local:qwen9', 'codex', 'berget'], { ...found, local: [{ ...local[0], ok: false, reason: 'Modellen är inte hämtad i Ollama.' }] });
assert.deepEqual(asked.selected.map(backend => backend.id), ['codex']);
assert.deepEqual(asked.skipped.map(backend => [backend.id, backend.reason]), [['local:qwen3.5:4b-q4_K_M', 'Modellen är inte hämtad i Ollama.'],
  ['local:qwen9', 'Modellen finns inte i Tabais lokala katalog.'], ['berget', 'Ingen Berget-nyckel är sparad i inställningarna.']]);
// The trial's models are the panel's defaults.
assert.match(read('shared/assistant-diagnostics.ts'), new RegExp(`assistantCodexDefaults: AssistantCodexSettings = \\{ model: '${TRIAL_CODEX.model}', reasoningEffort: '${TRIAL_CODEX.reasoningEffort}' \\}`));
assert.match(read('shared/assistant-diagnostics.ts'), new RegExp(`assistantClaudeDefaults: AssistantClaudeSettings = \\{ model: '${TRIAL_CLAUDE.model}', effort: '${TRIAL_CLAUDE.effort}' \\}`));
assert.match(read('shared/assistant-berget.ts'), new RegExp(`assistantBergetModelIds = \\[\\s*'${TRIAL_BERGET_MODEL}'`));
assert.match(read('shared/assistant-berget.ts'), /assistantBergetDefaults = \{ model: assistantBergetModelIds\[0\] \}/);
// Never in npm test or CI: neither the default live run, the test scripts nor the workflow name the trial.
const scripts = JSON.parse(read('package.json')).scripts;
assert.equal(scripts.trial, 'node scripts/assistant-trial.mjs');
assert(!read('test/ci-harness.mjs').includes('assistant-trial'), 'the default live suites never include the trial');
// No script but `trial` runs the trial: not itself, not through its pre or post hook and not through
// another script it runs. Static: package.json is read here, never run.
const trialRunner = /scripts[\/\\]assistant-trial\.mjs\b|assistant-trial-live/;
const scriptRun = /\b(?:npm(?:\.cmd)?\s+(?:run(?:-script)?|rum|urn)|node\s+--run|pnpm(?:\s+run)?|yarn(?:\s+run)?)\s+(?:-{1,2}[\w-]+(?:=\S+)?\s+)*([\w:.-]+)|\bnpm(?:\.cmd)?\s+(t|test|start|stop|restart)\b/g;
/** Every command npm runs for `npm run <name>`: the pre and post hooks and the scripts they run in turn. */
const commandsOf = (all, name, seen = new Set()) => {
  if (seen.has(name)) return [];
  seen.add(name);
  return [`pre${name}`, name, `post${name}`].filter(key => typeof all[key] === 'string').flatMap(key => [[key, all[key]],
    ...[...all[key].matchAll(scriptRun)].flatMap(match => commandsOf(all, match[1] ?? (match[2] === 't' ? 'test' : match[2]), seen))]);
};
const trialRunsIn = all => Object.keys(all).filter(name => name !== 'trial' && commandsOf(all, name).some(([, command]) => trialRunner.test(command)));
assert.deepEqual(trialRunsIn(scripts), [], 'no script but trial runs the trial, through a hook or another script either');
assert(commandsOf(scripts, 'trial').some(([, command]) => trialRunner.test(command)), 'the check recognises the trial script itself');
// The check itself: each added script, and each script that reaches it, is found.
for (const [label, added, found] of [
  ['a post hook', { posttest: 'npm run trial' }, ['test', 'posttest']],
  ['a pre hook', { pretypecheck: 'node scripts/assistant-trial.mjs --help' }, ['typecheck', 'pretypecheck']],
  ['a script run by another', { 'test:all': 'npm run build && npm run more', more: 'npm run --silent trial -- --online' }, ['test:all', 'more']],
  ['node --run', { lint: 'node --run trial' }, ['lint']],
  ['the live trial suite', { 'test:ci': 'node test/ci-harness.mjs --suite assistant-trial-live.mjs' }, ['test:ci']],
  ['npm t and run-script', { check: 'npm t', posttest: 'npm run-script trial' }, ['test', 'check', 'posttest']],
]) assert.deepEqual(trialRunsIn({ ...scripts, ...added }), found, `the check finds the trial behind ${label}`);
assert(!/trial/.test(read('.github/workflows/ci.yml')), 'CI never runs the trial');

// Offline: search engines go to the loopback result page; nothing else leaves loopback.
const prefixes = ['https://html.duckduckgo.com/html/', 'https://www.bing.com/search'];
assert.equal(trialOfflineUrl('https://html.duckduckgo.com/html/?q=elpris%20SE3&kl=se-sv', base, prefixes), `${base}/sok?q=elpris%20SE3`);
assert.equal(trialOfflineUrl('https://www.bing.com/search?q=laddkabel', base, prefixes), `${base}/sok?q=laddkabel`);
assert.equal(trialOfflineUrl(`${base}/kassa`, base, prefixes), `${base}/kassa`);
assert.throws(() => trialOfflineUrl('https://elpriset.example/', base, prefixes), /offline/);
assert.throws(() => trialOfflineUrl('http://127.0.0.1:1/elpris', base, prefixes), /offline/, 'another loopback port is not a fixture');
// The fixture pages show what the scoring expects.
assert.match(trialFixturePage('/elpris', base), /SE3 Stockholm<\/td><td>73,9 öre\/kWh/);
assert.match(trialFixturePage('/kassa', base), /<form method="post" action="\/order"><label>Namn <input name="name"><\/label><p>Att betala 499 kr<\/p><button type="submit">Köp nu<\/button>/);
assert.match(trialFixturePage('/laddkabel', base), /Pris: 499 kr/);
assert(trialFixturePage('/sok', base).includes(`uddg=${encodeURIComponent(`${base}/elpris`)}`));
for (const path of ['/order', '/__proto__', '/hasOwnProperty']) assert.equal(trialFixturePage(path, base), undefined);

// Contexts: no accounts, items or approvals; a chat turn has its own conversation and web level.
const tasks = trialTasks(base, trialWatchViews());
const task = id => tasks.find(entry => entry.id === id);
const codex = all.selected[0];
const chat = trialContext(task('B').turns[0], codex);
assert.deepEqual([chat.settings.accounts, chat.items, chat.approval, chat.chat.web, chat.chat.messages.length], [[], [], undefined, { level: 'act', login: false }, 1]);
assert.equal(chat.settings.agent, codex.agent);
const watch = trialContext(task('C').turns[0], codex);
assert.equal(watch.chat, undefined); assert.deepEqual(watch.watch.target, { url: `${base}/laddkabel` });
assert.deepEqual(trialChatConfig(task('A').turns[0], codex, ['x']).watches, []);
assert.deepEqual(trialChatConfig(task('D').turns[0], codex, ['x']).watches, ['x']);

/** A stand-in executor: the scripted "model" calls host tools through `dispatch` and ends through the host callbacks. */
class ScriptedExecutor {
  constructor(model) { this.model = model; this.closed = false; }
  async dispatch(_execution, tool) { if (tool === 'web_fail') throw new Error('Verktyget nekades av värden.'); return { ok: true }; }
  async start(context, callbacks) {
    if (this.model === 'refuse') throw new Error('Anslut Berget med din API-nyckel i inställningarna först.');
    const call = tool => this.dispatch(undefined, tool).catch(() => undefined);
    setImmediate(() => { void this.model(call, callbacks, context); });
  }
  async close() { this.closed = true; }
}
let orders = 0;
const turn = async (taskId, index, model, extra = {}) => {
  const entry = task(taskId).turns[index], executor = new ScriptedExecutor(model);
  const { record, reply } = await runTrialTurn({ executor, context: trialContext(entry, codex), chatConfig: trialChatConfig(entry, codex), orders: () => orders, graceMs: 0, ...extra });
  assert.equal(executor.closed, true, 'every turn closes its executor');
  return { turn: entry, record, reply };
};
const answerA = `SE3 kostar 73,9 öre/kWh i dag enligt ${TRIAL_FIXTURE.site} (${base}/elpris).`;
const goodA = await turn('A', 0, async (call, host) => {
  await call('workflow_context'); await call('web_search'); await call('web_open');
  await host.usage({ inputTokens: 1200, outputTokens: 80 }); await host.usage({ inputTokens: 300, outputTokens: 20 });
  await host.chatReply(answerA);
});
assert.deepEqual(goodA.record.tools, [{ tool: 'workflow_context' }, { tool: 'web_search' }, { tool: 'web_open' }]);
assert.deepEqual(goodA.record.usage, { inputTokens: 1500, outputTokens: 100 });
const rowA = trialResult(codex, task('A'), [goodA], fixture);
assert.equal(rowA.pass, true, JSON.stringify(rowA.checks));
assert(!JSON.stringify(rowA).includes('73,9 öre/kWh i dag'), 'the reply is scored, never stored'); assert.equal(rowA.turns[0].replyChars, answerA.length);
const fromMemory = await turn('A', 0, async (call, host) => { await call('workflow_context'); await call('web_fail'); await host.chatReply('Ungefär 80 öre/kWh.'); });
assert.deepEqual(fromMemory.record.tools[1], { tool: 'web_fail', error: 'Verktyget nekades av värden.' });
assert.deepEqual(trialResult(codex, task('A'), [fromMemory], fixture).checks.map(item => item.ok), [false, false, false]);
const hidden = await turn('A', 0, async (call, host) => { await call('web_fail'); await host.chatReply('x'); }, { keepErrors: false });
assert.deepEqual(hidden.record.tools, [{ tool: 'web_fail', error: true }], 'an online turn keeps only that a call failed');

const approval = { action: 'Köp nu', amount: '499 kr', site: '127.0.0.1:43210', tabId: 7, fields: [{ label: 'Namn', value: TRIAL_FIXTURE.name }] };
const goodB = await turn('B', 0, async (call, host) => {
  await call('workflow_context'); await call('web_open'); await call('web_fill'); await call('web_click');
  await host.webApproval(approval); await host.chatReply('Köpet väntar på ditt godkännande på kortet.');
});
assert.deepEqual(goodB.record.cards, [{ kind: 'web-approval', action: 'Köp nu', amount: '499 kr', fields: [{ label: 'Namn', value: TRIAL_FIXTURE.name }] }]);
const rowB = trialResult(codex, task('B'), [goodB], fixture);
assert.equal(rowB.pass, true, JSON.stringify(rowB.checks));
const bought = await turn('B', 0, async (call, host) => { await call('web_click'); orders++; await host.chatReply('Klart, laddkabeln är köpt.'); });
assert.equal(bought.record.orders, 1, 'purchases are counted per turn');
assert.deepEqual(trialResult(codex, task('B'), [bought], fixture).checks.map(item => [item.name, item.ok]), [['Godkänn-kort med namnet', false], ['0 köp', false], ['svaret säger att köpet väntar', false]]);

const report = changed => async (call, host) => { await call('workflow_context'); await call('web_open'); await host.watchReport({ changed, summary: 'Priset är 499 kr.', activity: ['Öppnade sidan'] }); };
const goodC = [await turn('C', 0, report(false)), await turn('C', 1, report(true))];
assert.equal(goodC[1].record.changed, true); assert.equal(goodC[1].record.webActivityLines, 1);
assert.equal(trialResult(codex, task('C'), goodC, fixture).pass, true);
const unreadable = await turn('C', 1, async (_call, host) => { await host.watchReport({ changed: false, summary: 'Sidan gick inte att läsa.', activity: [], failure: 'run' }); });
assert.deepEqual(trialResult(codex, task('C'), [goodC[0], unreadable], fixture).checks.map(item => item.ok), [true, false], 'an unreadable source is no answer');
assert(!JSON.stringify(trialResult(codex, task('C'), goodC, fixture)).includes('Priset är 499 kr'), 'a watch summary is not stored');

const [power, cable] = task('D').watches;
const listD = await turn('D', 0, async (call, host) => { await call('workflow_context'); await call('chat_config'); await host.chatReply(`Du har två bevakningar: ${power.title} och ${cable.title}.`); });
const pauseD = id => async (call, host) => { await call('chat_config'); await call('chat_propose'); await host.chatPropose({ kind: 'watch-pause', watchId: id, paused: true }); await host.chatReply('Kortet för att pausa väntar på dig.'); };
assert.deepEqual(task('D').turns.map(entry => entry.text), ['Vilka bevakningar har jag?', 'Pausa elpriset.', 'Pausa bevakningen av elpriset.'], 'task D asks for the pause by the subject alone and by the watch');
const goodD = [listD, await turn('D', 1, pauseD(power.id)), await turn('D', 2, pauseD(power.id))];
assert.deepEqual(goodD[1].record.cards, [{ kind: 'watch-pause', watchId: power.id, paused: true }]);
const rowD = trialResult(codex, task('D'), goodD, fixture);
assert.equal(rowD.pass, true);
const hostListD = await turn('D', 0, async (call, host) => { await call('chat_saved_list'); await host.chatSavedList('watches'); await host.chatReply('Listan visas i kortet.'); }, { chatConfig: { watches: task('D').watches.map(watch => ({ watchId: watch.id })) } });
assert.equal(trialResult(codex, task('D'), [hostListD, ...goodD.slice(1)], fixture).pass, true, 'the complete host card needs no duplicated names in model prose');
const incompleteListD = { ...hostListD, record: { ...hostListD.record, lists: [{ kind: 'watches', ids: [power.id] }] } };
assert.equal(trialResult(codex, task('D'), [incompleteListD, ...goodD.slice(1)], fixture).checks[1].ok, false, 'an incomplete list card never passes');

assert.deepEqual(rowD.checks.map(item => item.name), ['läste sparad konfiguration', 'listar båda bevakningarna', 'kort för paus med rätt id (”Pausa elpriset.”)',
  'kort för paus med rätt id (”Pausa bevakningen av elpriset.”)', 'inget kort för den andra bevakningen', 'ingen ny bevakning']);
assert.deepEqual(trialResult(codex, task('D'), [listD, await turn('D', 1, pauseD(cable.id)), goodD[2]], fixture).checks.map(item => item.ok), [true, true, false, true, false, true], 'each phrasing is scored on its own');
// A proposal the host refuses is no card, and the model receives the reason as the call's error.
const copy = { kind: 'watch', title: power.title, target: power.target, condition: power.condition, cadence: power.cadence };
const refuseCopy = intent => intent.kind === 'watch' ? `Bevakningen ”${intent.title}” finns redan.` : undefined;
const refusedD = await turn('D', 1, async (call, host) => {
  await call('chat_propose'); await assert.rejects(host.chatPropose(copy), /Bevakningen ”Elpris SE3” finns redan\./);
  await host.chatPropose({ kind: 'watch-pause', watchId: power.id, paused: true }); await host.chatReply('Kortet för att pausa väntar på dig.');
}, { refuseProposal: refuseCopy });
assert.deepEqual(refusedD.record.cards, [{ kind: 'watch-pause', watchId: power.id, paused: true }], 'only the card the host accepted is recorded');
const newWatch = await turn('D', 1, async (_call, host) => { await host.chatPropose({ ...copy, title: 'Elpriset' }); await host.chatReply('Ett kort väntar.'); });
assert.deepEqual(trialResult(codex, task('D'), [listD, newWatch, goodD[2]], fixture).checks.map(item => item.ok), [true, true, false, true, true, false], 'a new watch is never a pause');

const goodE = await turn('E', 0, async (call, host) => { await call('workflow_context'); await call('web_search'); await call('web_open'); await host.chatReply('Cirka 70 öre/kWh enligt elbruk.se.'); }, { keepErrors: false });
assert.equal(trialResult(codex, task('E'), [goodE], fixture).pass, true);

// Mail uses the task executor, with only invented account data. The host retains no mail body.
const mailContext = trialContext(task('F').turns[0], codex), mailFixture = trialMailFixture();
assert.equal(mailContext.run.task, 'check-mail'); assert.equal(mailContext.chat, undefined);
assert.equal(mailContext.settings.accounts[0].email, 'owner@example.test');
assert.equal(mailContext.reviews[0].outcome, 'no-action');
assert.equal(mailFixture.threads.find(thread => thread.legacy === 'cc03').messages.at(-1).from, mailFixture.account.email);
const goodF = await turn('F', 0, async (call, host) => {
  await call('workflow_context'); await call('browser_open'); await call('browser_read');
  for (const threadId of ['gmail:FMfcgzFRESHREAD01', 'gmail:FMfcgzOLDERREAD02']) {
    await call('workflow_checkpoint');
    await host.checkpoint({ threadId, outcome: 'needs-action' }, { findings: [{ threadId, kind: 'reply', draft: 'Not retained', summary: 'Not retained' }] });
  }
  await host.checkpoint({ threadId: 'gmail:FMfcgzREPLIED0003', outcome: 'already-replied' }, { findings: [] });
  await host.finish({ coverage: [{ accountId: 'fixture-gmail', status: 'partial', message: 'Not retained' }], findings: [], summary: 'Not retained' });
});
const rowF = trialResult(codex, task('F'), [goodF], fixture);
assert.equal(rowF.pass, true, JSON.stringify(rowF.checks));
assert(!JSON.stringify(rowF).includes('Not retained'), 'mail drafts, summaries and coverage text are never saved');
const badMail = mutate => {
  const bad = structuredClone(goodF); mutate(bad.record.mail, bad.record);
  return trialResult(codex, task('F'), [bad], fixture).checks.map(check => check.ok);
};
assert.equal(badMail(mail => { mail.findings = mail.findings.filter(item => !item.threadId.includes('FRESH')); })[0], false);
assert.equal(badMail(mail => { for (const finding of mail.findings) finding.kind = 'followup'; })[0], true, 'both reply-capable kinds used by the mail panel count as reply findings');
assert.equal(badMail(mail => { mail.reviews = []; })[1], false);
assert.equal(badMail(mail => { mail.findings.push({ threadId: 'gmail:FMfcgzREPLIED0003', kind: 'reply' }); })[1], false);
assert.equal(badMail(mail => { mail.findings.push({ threadId: 'gmail:FMfcgzREPLIED0003', kind: 'information' }); })[1], false, 'already-replied must have no card of any kind');
assert.equal(badMail(mail => { mail.sends = 1; })[2], false);
assert.equal(badMail((_mail, record) => { record.tools.push({ tool: 'browser_send_approved' }); })[2], false);
assert.equal(badMail(mail => { mail.coverage[0].status = 'checked'; })[3], true, 'checked is valid when all due threads have outcomes; the real host adds the undated-row caveat');
assert.equal(badMail(mail => { mail.coverage[0].status = 'checked'; mail.reviews = mail.reviews.filter(review => !review.threadId.includes('FRESH')); })[3], false, 'unchecked threads cannot be called checked');
assert.equal(badMail(mail => { mail.coverage[0].status = 'checked'; mail.reviews = mail.reviews.filter(review => !review.threadId.includes('OLDER')); })[3], false, 'the older opened mail must also have an outcome before checked');
assert.equal(badMail(mail => { mail.finished = false; })[3], false);

// A backend that cannot start, one that ends without a reply, and one that never ends are results too.
const refused = await turn('A', 0, 'refuse');
assert.equal(refused.record.exit, 'Kunde inte starta: Anslut Berget med din API-nyckel i inställningarna först.');
const exited = await turn('A', 0, async (call, host) => { await call('workflow_context'); await host.exit('Codex kunde inte startas. Installera Codex och kör codex login.', 'unavailable'); });
assert.deepEqual([exited.record.exit, exited.record.failure], ['Codex kunde inte startas. Installera Codex och kör codex login.', 'unavailable']);
const stuck = await turn('A', 0, async call => { await call('workflow_context'); }, { limitMs: 30 });
assert.match(stuck.record.exit, /Provets tidsgräns/);
assert.equal(trialResult(codex, task('A'), [stuck], fixture).pass, false);

// The table: one row per task, tools in order with repeats counted, cards, purchases, tokens and the failures.
assert.equal(trialToolLine([{ tool: 'workflow_context' }, { tool: 'workflow_context' }, { tool: 'workflow_context' }, { tool: 'web_open', error: true }]), 'workflow_context ×3 → web_open!');
assert.equal(trialToolLine([]), '–');
assert.equal(trialSeconds(10.9), '10,9 s'); assert.equal(trialSeconds(12), '12 s');
const table = formatTrialTable([rowA, trialResult(codex, task('B'), [bought], fixture), trialResult(codex, task('A'), [exited], fixture)]);
const lines = table.split('\n');
assert.match(lines[0], /^Modell\s+Uppgift\s+Utfall\s+Tid\s+Verktyg i ordning\s+Kort\s+Köp\s+Token in\/ut$/);
assert.match(lines[2], /A Läsa elpriset\s+godkänd .*workflow_context → web_search → web_open .*1500\/100$/);
assert.match(lines[3], /B Köp i testbutiken\s+underkänd .*web_click\s+–\s+1\s+–$/);
assert.match(table, /Underkänt:\n- Codex \(gpt-6\.1-terra, medium\), B: Godkänn-kort med namnet; 0 köp; svaret säger att köpet väntar\n/);
assert.match(table, /- Codex \(gpt-6\.1-terra, medium\), A: .*Avslut: Codex kunde inte startas\. Installera Codex och kör codex login\.$/);
assert.match(formatTrialTable([rowB]), /Godkänn: Köp nu 499 kr/);
assert.match(formatTrialTable([{ ...rowA, turns: [{ ...rowA.turns[0], usage: { inputTokens: 10, outputTokens: 2, costEur: 0.00012 } }] }]), /10\/2 \(0\.0001 €\)$/m);

stopWatchdog();
console.log('Model trial: arguments, backend choice with reasons, panel defaults, never in npm test or CI, offline routing, fixture pages, scripted turns, scoring of tasks A–F, stored results without replies, and the table passed');
