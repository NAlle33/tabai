// Disposable module exercising generic panel controls, never real accounts.
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const file = process.argv[2];
let state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { drafts: { start: { context: 'start', revision: 0, values: {} } }, runs: [] };
let filter = { query: '', archived: false, offset: 0 };
const current = () => state.runs.find(run => run.id === state.current);
const review = () => ({ title: 'Underlag', summary: 'Kontrollera uppgifterna.', overview: [{ label: 'Ämne', value: current().summary, status: 'confirmed', sources: [] }],
  verification: { state: 'pending', message: 'Behöver kontrolleras.', issues: [] }, sections: [{ title: 'Uppgifter', items: [{ id: 'subject', editValue: current().summary, label: 'Ämne', value: current().summary, status: 'confirmed', sources: [{ label: 'Ditt svar', quote: current().summary }] }] }] });
function view() {
  const run = current(), rows = state.runs.filter(item => !!item.archived === filter.archived && item.title.includes(filter.query));
  return { title: 'Personlig arbetsyta', description: 'Isolerad kontroll av arbetsflödet.', startLabel: 'Starta uppdrag',
    fields: [{ name: 'request', label: 'Beskriv uppdraget', multiline: true, required: true }, { name: 'option', label: 'Valfri inställning', advanced: true },
      { name: 'link', label: 'Mejlets adress', advanced: true }, { name: 'extra', label: 'Gammal länk', advanced: true }],
    drafts: { start: state.drafts.start, ...(run?.question ? { reply: state.drafts[run.questionId] || { context: run.questionId, revision: 0, values: {} } } : {}) },
    ...(run ? { run: { ...run, archived: !!run.archived, review: review(), canCorrect: !run.question && !run.archived, canResume: run.status === 'paused' && !run.archived, ...(run.archived ? {} : { messaging: 'ready' }), ...(run.status === 'running' && !run.archiveBlocked ? { stopAndArchive: true } : {}) } } : {}),
    mailStart: { label: 'Skapa uppdrag', mailField: 'request', accountField: 'option', linkField: 'link', clearFields: ['extra'], providers: ['outlook', 'zoho'], keywords: state.keywords || [] },
    ...(state.mailRuns ? { mailRuns: state.mailRuns } : {}),
    history: rows.slice(filter.offset, filter.offset + 20).map(item => ({ id: item.id, label: item.title, detail: item.message, archived: !!item.archived })), historyPage: { ...filter, total: rows.length } };
}
function command(operation, input) {
  const run = current();
  if (operation === 'draft') {
    const previous = state.drafts[input.context] || { context: input.context, revision: 0, values: {} };
    if (input.context !== 'start' && input.context !== run?.questionId) throw new Error('Wrong context');
    if (previous.revision !== Number(input.revision)) throw new Error('Stale revision');
    const values = JSON.parse(input.values);
    if (values.answer === 'Simulerat lagringsfel') throw new Error('Isolated failure');
    state.drafts[input.context] = { context: input.context, revision: previous.revision + 1, values, updatedAt: new Date().toISOString() };
  }
  if (operation === 'start') {
    state.current = 'case-current';
    if (!current()) state.runs.push({ id: state.current, title: input.request, status: 'waiting', message: 'Ett svar behövs', summary: input.request, question: 'Vilken period gäller?', questionId: 'question-current', choices: [{ label: 'September', value: 'September' }], actionLabel: 'Besvara en fråga' });
    state.drafts.start = { context: 'start', revision: state.drafts.start.revision + 1, values: {} };
    if (input.link) state.mailRuns = [{ link: input.link, runId: state.current, label: 'Arbetar', handled: false }, ...(state.mailRuns || []).filter(entry => entry.link !== input.link)];
    for (let i = 0; i < 25; i++) if (!state.runs.some(item => item.id === `case-${i}`)) state.runs.push({ id: `case-${i}`, title: `Tidigare uppdrag ${i}`, summary: 'Sparat underlag', status: 'paused', message: 'Pausat', actionLabel: 'Fortsätt ärendet' });
  }
  if (operation === 'reply') {
    if (input['run-id'] !== run.id || input['question-id'] !== run.questionId) throw new Error('Stale question');
    state.drafts[run.questionId] = { context: run.questionId, revision: (state.drafts[run.questionId]?.revision || 0) + 1, values: {} };
    run.summary = input.answer; run.status = 'review'; run.message = 'Klart för granskning'; run.actionLabel = 'Granska underlaget'; delete run.question; delete run.questionId; delete run.choices;
  }
  if (operation === 'message') {
    if (run.id !== input['run-id']) throw new Error('Stale run');
    const at = new Date().toISOString();
    (run.conversation ??= []).push({ id: input['message-id'], role: 'owner', text: input.message, at }, { id: randomUUID(), role: 'agent', text: `Svar på: ${input.message}`, at });
  }
  // Puts the current case to work; `blocked` makes it one the module cannot archive now.
  if (operation === 'resume') {
    if (run.id !== input['run-id']) throw new Error('Stale run');
    run.status = 'running'; run.message = 'Arbetar';
    if (input.nostop === 'true') run.canStop = false; else delete run.canStop;
    if (input.blocked === 'true') run.archiveBlocked = 'Publiceringen pågår och kan inte avbrytas.'; else delete run.archiveBlocked;
  }
  // Test controls: the words that make a mail a request, and a mail-started case being handled.
  if (operation === 'correct' && input.field === 'keywords') state.keywords = input.value ? input.value.split(',') : [];
  else if (operation === 'correct' && input.field === 'resume-label') { if (input.value) run.resumeLabel = input.value; else delete run.resumeLabel; }
  // With `link`, only the case started from that mail is handled.
  else if (operation === 'correct' && input.field === 'handled') state.mailRuns = (state.mailRuns || []).map(entry => input.link && entry.link !== input.link ? entry : ({ ...entry, handled: true, handledAt: new Date().toISOString(), label: 'Klart' }));
  else if (operation === 'correct') { if (run.id !== input['run-id'] || input.field !== 'subject') throw new Error('Wrong field'); run.summary = input.value; run.status = 'paused'; run.message = 'Din ändring är sparad'; }
  if (operation === 'history') filter = { query: input.query || '', archived: input.archived === 'true', offset: Number(input.offset || 0) };
  if (['select', 'archive', 'restore'].includes(operation)) {
    const target = state.runs.find(item => item.id === input['case-id']); if (!target) throw new Error('Missing case');
    // Like a real module, no other case is selected while the current one works.
    if (operation === 'select' && current()?.status === 'running') throw new Error('Busy');
    if (operation === 'archive') {
      if (target.archiveBlocked) throw new Error('Blocked');
      if (target.status === 'running') { target.status = 'paused'; target.message = 'Stoppad och arkiverad'; }
      target.archived = true; if (state.current === target.id) delete state.current;
    }
    else { state.current = target.id; if (operation === 'restore') target.archived = false; }
  }
  if (operation !== 'status' && operation !== 'history') writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  return view();
}
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const request = JSON.parse(line);
  try { process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: command(request.operation, request.input || {}) }) + '\n'); }
  catch { process.stdout.write(JSON.stringify({ id: request.id, ok: false }) + '\n'); }
});
lines.on('close', () => process.exit(0));
