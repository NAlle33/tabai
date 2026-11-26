import { node } from './module-views';
import { button, timestamp } from './assistant-controls';
import type { AssistantAccountTest } from '../../shared/assistant-diagnostics';
const resultLabels = { running: 'Test pågår', passed: 'Läsåtkomsten fungerar', partial: 'Delar behöver hjälp', failed: 'Testet kunde inte slutföras', interrupted: 'Testet avbröts' };
const stepLabels = { identity: 'Rätt konto', inbox: 'Läsa inkorgen', thread: 'Läsa en hel tråd', sent: 'Läsa Skickat' };
const statusLabels = { pending: 'Väntar', running: 'Kontrollerar', passed: 'Fungerar', failed: 'Behöver hjälp', skipped: 'Inte kontrollerat' };

export function renderAccountTest(root: HTMLElement, result: AssistantAccountTest | undefined, timezone: string, open: () => void, stop: () => void = () => {}) {
  root.replaceChildren();
  if (!result) { root.append(node('p', 'Inget sparat kontotest. Testa läsåtkomsten när du är inloggad.', 'muted')); return; }
  root.dataset.testStatus = result.status;
  const heading = node('p', resultLabels[result.status], result.status === 'passed' ? 'assistant-success' : 'assistant-test-heading');
  const tested = node('p', result.status === 'running' ? 'Startat: ' : 'Senast testat: ', 'muted'); tested.append(timestamp(result.status === 'running' ? result.startedAt : result.updatedAt, timezone));
  root.append(heading, tested);
  const steps = node('ol', '', 'assistant-test-steps');
  for (const key of ['identity', 'inbox', 'thread', 'sent'] as const) {
    const step = result.steps.find(step => step.key === key), row = node('li'); row.dataset.testStep = key; row.dataset.stepStatus = step?.status || 'pending';
    row.append(node('strong', stepLabels[key]), node('span', statusLabels[step?.status || 'pending'], 'assistant-test-step-status'));
    if (step?.message) row.append(node('p', step.message, 'muted'));
    steps.append(row);
  }
  root.append(steps);
  const next = result.status === 'passed' ? 'Nästa steg: starta en uppgift när du vill granska mejlen.'
    : result.status === 'running' ? 'Testet läser bara. Du kan följa det i Chrome.'
    : result.status === 'interrupted' ? 'Nästa steg: välj Testa läsåtkomst när du vill starta ett nytt test.'
    : 'Nästa steg: öppna testet i Chrome, åtgärda steget som behöver hjälp och testa kontot igen.';
  root.append(node('p', next, 'muted'));
  if (result.status === 'running') { const control = button('Stoppa självtestet', stop); control.dataset.stopAccountTest = result.accountId; root.append(control); }
  if (result.status !== 'interrupted' && (result.tabId !== undefined || result.status !== 'passed')) root.append(button('Visa test i Chrome', open));
}
