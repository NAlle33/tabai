import { randomUUID } from 'node:crypto';
import type { AssistantAccount } from '../shared/assistant';
import { assistantAccountTestSchema, type AssistantAccountTest, type AssistantAccountTestStep } from '../shared/assistant-diagnostics';
import type { AssistantBrowser } from './assistant-browser';

type StepKey = AssistantAccountTestStep['key'];
type AccountTestBrowser = Pick<AssistantBrowser, 'open' | 'read' | 'action'> & {
  mailboxFolder(account: AssistantAccount, area: 'inbox' | 'sent'): Promise<Record<string, unknown>>;
  firstMessageRef(tabId: number): Promise<string | undefined>;
};
type Failure = { code: string; message: string };
const stepKeys: StepKey[] = ['identity', 'inbox', 'thread', 'sent'];
const stamp = () => new Date().toISOString();
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
const validTab = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const supportedFolder = (value: Record<string, unknown>, area: 'inbox' | 'sent') =>
  ['list', 'detail', 'empty'].includes(String(value.view)) && Array.isArray(value.areas) && value.areas.includes(area);

function failure(code: unknown): Failure {
  const safe = typeof code === 'string' && /^[a-z][a-z0-9-]{0,99}$/.test(code) ? code : 'browser-error';
  let message = 'Webbläsarkontakten kunde inte verifieras. Kontrollera att Chrome och Tabai är igång och kör testet igen.';
  if (safe === 'account-mismatch') message = 'Fel konto eller flera konton visas. Välj det sparade kontot i assistentfliken och kör testet igen.';
  else if (safe === 'login-required') message = 'Logga in på det sparade kontot i assistentfliken och kör testet igen.';
  else if (safe === 'identity-unavailable') message = 'Kontots identitet kunde inte verifieras. Öppna kontomenyn manuellt och kör testet igen.';
  else if (['loading', 'foreground-required', 'focus-disabled'].includes(safe)) message = 'Öppna assistentfliken i Chrome och vänta tills mejlvyn har laddats. Kör sedan testet igen.';
  else if (['tab-closed', 'unowned-tab'].includes(safe)) message = 'Assistentfliken är inte tillgänglig. Öppna kontot igen från panelen och kör testet igen.';
  else if (safe === 'navigation-changed') message = 'Sidan ändrades under kontrollen. Visa rätt mejlvy i assistentfliken och kör testet igen.';
  else if (['layout', 'unsupported-route', 'folder-unavailable'].includes(safe)) message = 'Mejlvyn kunde inte identifieras. Öppna kontots vanliga mejlvy i assistentfliken och kör testet igen.';
  else if (safe === 'thread-reference-unavailable') message = 'Ingen säker referens till ett meddelande hittades. Öppna Inkorgens vanliga meddelandelista och kör testet igen.';
  else if (safe === 'history-incomplete') message = 'Hela trådhistoriken kunde inte läsas. Öppna äldre meddelanden i assistentfliken och kör testet igen.';
  else if (safe === 'truncated') message = 'Trådens läsning är förkortad. Öppna den fullständiga konversationen i assistentfliken och kör testet igen.';
  else if (safe === 'message-identity-unavailable') message = 'Trådens och meddelandets identitet kunde inte verifieras. Öppna meddelandet i en egen detaljvy och kör testet igen.';
  return { code: safe, message };
}

function returnedFailure(value: Record<string, unknown>, allowUnsupportedLayout = false): Failure | undefined {
  if (typeof value.code === 'string') return failure(value.code);
  if (value.status === 'login' || value.loginRequired === true) return failure('login-required');
  if (value.status === 'failed' || value.isError === true) return failure('read-failed');
  if (value.status === 'unsupported' && !allowUnsupportedLayout) return failure('layout');
  return undefined;
}

function folderFailure(value: Record<string, unknown>, error: Failure | undefined, accountId: string, area: "inbox" | "sent"): Failure | undefined {
  return error ?? returnedFailure(value)
    ?? (value.accountId !== accountId ? failure(value.accountId ? "account-mismatch" : "identity-unavailable") : undefined)
    ?? (!validTab(value.tabId) ? failure("tab-closed") : undefined)
    ?? (!supportedFolder(value, area) ? failure("layout") : undefined);
}

function caughtFailure(value: unknown): Failure {
  const error = record(value);
  return error.name === 'AssistantBrowserError' ? failure(error.code) : failure('browser-error');
}

async function attempt<T>(operation: () => Promise<T>): Promise<{ value: T; error?: never } | { error: Failure; value?: never }> {
  try { return { value: await operation() }; }
  catch (error) { return { error: caughtFailure(error) }; }
}

export function initialAssistantAccountTest(accountId: string, timestamp: string): AssistantAccountTest {
  if (!/^[a-z0-9-]{1,60}$/.test(accountId)) throw new Error('Välj ett giltigt sparat konto för självtestet.');
  const result = assistantAccountTestSchema.safeParse({ id: randomUUID(), accountId, startedAt: timestamp, updatedAt: timestamp, status: 'running',
    steps: stepKeys.map(key => ({ key, status: 'pending', message: 'Väntar på kontroll.' })) });
  if (!result.success) throw new Error('Självtestet saknar en giltig starttid.');
  return result.data;
}

/** Verifies native reading capabilities; the report contains no mailbox content. */
export async function runAssistantAccountTest(browser: AccountTestBrowser, account: AssistantAccount, initial: AssistantAccountTest,
  onProgress: (report: AssistantAccountTest) => void | Promise<void>): Promise<AssistantAccountTest> {
  const checked = assistantAccountTestSchema.safeParse(initial);
  if (!checked.success || initial.accountId !== account.id || initial.steps.some((step, index) => step.key !== stepKeys[index])) throw new Error('Självtestet gäller inte det valda kontot. Starta ett nytt test.');
  const report = checked.data;
  report.status = 'running';
  report.steps = stepKeys.map(key => ({ key, status: 'pending', message: 'Väntar på kontroll.' }));
  const emit = async () => { report.updatedAt = stamp(); await onProgress(structuredClone(report)); };
  const progress = async (key: StepKey, status: AssistantAccountTestStep['status'], message: string, code?: string) => {
    report.steps[stepKeys.indexOf(key)] = { key, status, message, ...(code ? { code } : {}) };
    await emit();
  };
  const failed = (key: StepKey, error: Failure) => progress(key, 'failed', error.message, error.code);
  const read = async (tabId: number) => {
    let result = await attempt(() => browser.read(tabId));
    // A fresh read can settle a known SPA route change; clicks are never replayed.
    if (result.error?.code === 'navigation-changed') result = await attempt(() => browser.read(tabId));
    return result;
  };

  await progress('identity', 'running', 'Verifierar det sparade kontot i assistentfliken.');
  const opened = await attempt(() => browser.open(account));
  const opening = record(opened.value);
  if (validTab(opening.tabId)) report.tabId = opening.tabId;
  const identityFailure = opened.error ?? returnedFailure(opening, true)
    ?? (opening.accountId !== account.id ? failure(opening.accountId ? 'account-mismatch' : 'identity-unavailable') : undefined)
    ?? (!validTab(opening.tabId) ? failure('tab-closed') : undefined);
  if (identityFailure) {
    report.steps[0] = { key: 'identity', status: 'failed', ...identityFailure };
    for (const key of stepKeys.slice(1)) report.steps[stepKeys.indexOf(key)] = { key, status: 'skipped', message: 'Kontots identitet måste verifieras innan mejlvyer får läsas.' };
    report.status = 'failed'; await emit(); return structuredClone(report);
  }
  await progress('identity', 'passed', 'Det sparade kontots identitet är verifierad i assistentfliken.');

  await progress('inbox', 'running', 'Öppnar och identifierar Inkorgens vanliga mejlvy.');
  const inboxResult = await attempt(() => browser.mailboxFolder(account, 'inbox'));
  const inbox = record(inboxResult.value);
  const inboxFailure = folderFailure(inbox, inboxResult.error, account.id, 'inbox');
  if (validTab(inbox.tabId)) report.tabId = inbox.tabId;
  if (inboxFailure) {
    await failed('inbox', inboxFailure);
    await progress('thread', 'skipped', 'En säker Inkorg måste kunna öppnas innan en meddelandetråd kan testas.');
  } else {
    await progress('inbox', 'passed', inbox.view === 'empty' ? 'Inkorgens vanliga vy är identifierad som tom.' : 'Inkorgens mejlvy kan läsas. Detta test granskar inte hela brevlådan.');
    if (inbox.view === 'empty') await progress('thread', 'skipped', 'Inkorgen är verifierat tom. Trådläsning kan testas när det finns ett meddelande i Inkorgen.');
    else {
      await progress('thread', 'running', 'Öppnar en säker meddelandereferens och kontrollerar hela trådhistoriken.');
      const tabId = inbox.tabId as number;
      const reference = await attempt(() => browser.firstMessageRef(tabId));
      let threadFailure = reference.error;
      if (!threadFailure && (typeof reference.value !== 'string' || !/^ref_\d+$/.test(reference.value))) threadFailure = failure('thread-reference-unavailable');
      if (!threadFailure) {
        const clicked = await attempt(() => browser.action('browser_click', { tabId, ref: reference.value }));
        threadFailure = clicked.error ?? returnedFailure(record(clicked.value));
        if (!threadFailure) {
          const reading = await read(tabId);
          let detail = record(reading.value);
          threadFailure = reading.error ?? returnedFailure(detail);
          if (!threadFailure && detail.accountId !== account.id) threadFailure = failure(detail.accountId ? 'account-mismatch' : 'identity-unavailable');
          if (!threadFailure && detail.view === 'detail' && (detail.historyComplete !== true || detail.truncated !== false)) {
            const expanded = await attempt(() => browser.action('browser_expand_thread', { tabId }));
            detail = record(expanded.value);
            threadFailure = expanded.error ?? returnedFailure(detail);
          }
          if (!threadFailure) threadFailure = detail.accountId !== account.id ? failure(detail.accountId ? 'account-mismatch' : 'identity-unavailable')
            : detail.view !== 'detail' ? failure('layout')
            : detail.truncated !== false ? failure('truncated')
            : detail.historyComplete !== true ? failure('history-incomplete')
            : typeof detail.sourceId !== 'string' || !detail.sourceId || typeof detail.messageId !== 'string' || !detail.messageId ? failure('message-identity-unavailable') : undefined;
        }
      }
      if (threadFailure) await failed('thread', threadFailure);
      else await progress('thread', 'passed', 'En meddelandetråd med komplett historik och stabil meddelandeidentitet kan läsas.');
    }
  }

  await progress('sent', 'running', 'Öppnar och identifierar Skickat-vyn oberoende av trådtestet.');
  const sentResult = await attempt(() => browser.mailboxFolder(account, 'sent'));
  const sent = record(sentResult.value);
  const sentFailure = folderFailure(sent, sentResult.error, account.id, 'sent');
  if (validTab(sent.tabId)) report.tabId = sent.tabId;
  if (sentFailure) await failed('sent', sentFailure);
  else await progress('sent', 'passed', sent.view === 'empty' ? 'Skickat-vyn är identifierad som tom.' : 'Skickat-vyn är identifierad och läsbar. Testet granskar inte alla skickade meddelanden.');
  report.status = report.steps.every(step => step.status === 'passed') ? 'passed' : 'partial';
  await emit();
  return structuredClone(report);
}
