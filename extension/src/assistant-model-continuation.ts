import { node } from './module-views';
import { button } from './assistant-controls';
import { assistantPrivacy, chatModelSelect } from './assistant-chat-settings';

let continuationSequence = 0;
export function setContinuationBusy(root: HTMLDetailsElement, busy: boolean) {
  root.dataset.busy = String(busy);
  // Reading status must not blur an editable choice. Only its own submission freezes it.
  root.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button, select').forEach(control => { control.disabled = root.dataset.pending === 'true' || control.tagName === 'BUTTON' && busy; });
}

/** An explicit choice for one continuation; it never writes model settings. */
export function modelContinuation(model: string, busy: boolean, start: (model: string) => Promise<boolean>) {
  const root = node('details', '', 'assistant-model-continuation');
  root.append(node('summary', 'Fortsätt med annan modell'));
  const label = node('label', 'Modell för fortsättningen'), select = chatModelSelect('continuation-model');
  select.id = `assistant-continuation-${++continuationSequence}`;
  select.value = model;
  label.append(select);
  const privacy = node('p', assistantPrivacy(select.value), 'muted');
  privacy.setAttribute('aria-live', 'polite');
  const submit = button('Fortsätt', async () => {
    root.dataset.pending = 'true'; setContinuationBusy(root, root.dataset.busy === 'true');
    try { if (await start(select.value)) root.open = false; }
    finally { delete root.dataset.pending; setContinuationBusy(root, root.dataset.busy === 'true'); }
  }, 'quiet');
  select.addEventListener('change', () => { privacy.textContent = assistantPrivacy(select.value); });
  root.append(label, privacy, node('p', 'Valet gäller bara den här fortsättningen. Standardmodellen ändras inte.', 'muted'), submit);
  setContinuationBusy(root, busy);
  return root;
}
