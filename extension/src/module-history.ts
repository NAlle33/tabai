import type { ModuleOperation, ModuleView } from '../../shared/personal-modules';
import { archiveChoice } from './module-views';
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '') { const el = document.createElement(tag); el.textContent = text; return el; }
export function renderModuleHistory(root: HTMLElement, view: ModuleView, act: (operation: ModuleOperation, input: Record<string, string>) => Promise<void>) {
  if (!view.history?.length && !view.historyPage) { root.replaceChildren(); return; }
  const details = node('details'); details.open = root.querySelector('details')?.open ?? false;
  details.append(node('summary', 'Tidigare ärenden'));
  const button = (label: string, operation: ModuleOperation, input: Record<string, string>) => {
    const el = node('button', label); el.type = 'button'; el.onclick = () => void act(operation, input); return el;
  };
  const page = view.historyPage;
  if (page) {
    const previousSearch = root.querySelector<HTMLInputElement>('input[name="query"]');
    const form = node('form'), label = node('label', 'Sök ärende'), search = node('input');
    search.name = 'query'; search.defaultValue = page.query; search.maxLength = 300; search.placeholder = 'Uppdrag, kund, företag eller datum';
    if (previousSearch?.defaultValue === page.query) search.value = previousSearch.value;
    label.append(search);
    const filterLabel = node('label', 'Visa'), select = node('select');
    for (const [value, text] of [['false', 'Aktiva ärenden'], ['true', 'Arkiverade ärenden']]) { const option = node('option', text); option.value = value; select.append(option); }
    select.value = String(page.archived); filterLabel.append(select);
    const submit = node('button', 'Sök'); submit.type = 'submit';
    form.append(label, filterLabel, submit);
    const find = () => void act('history', { query: search.value, archived: select.value, offset: '0' });
    form.onsubmit = event => { event.preventDefault(); find(); }; select.onchange = find;
    details.append(form, node('p', `${page.total} ärenden`));
  }
  const list = node('ul'); list.className = 'module-history';
  const current = view.run && !view.run.archived ? view.run : undefined;
  const kept = new Set([...root.querySelectorAll<HTMLDetailsElement>('details[data-keep][open]')].map(entry => entry.dataset.keep));
  for (const item of view.history || []) {
    const li = node('li'); li.append(node('h3', item.label), node('p', item.detail));
    if (item.id) {
      const controls = node('div'); controls.className = 'module-choices';
      controls.append(button('Öppna ärendet', 'select', { 'case-id': item.id }));
      if (item.archived) controls.append(button('Återställ', 'restore', { 'case-id': item.id }));
      else if (item.id === current?.id && (current.archiveBlocked || current.status === 'running')) {
        const choice = archiveChoice(current, act);
        if (choice instanceof HTMLDetailsElement) choice.open = kept.has(choice.dataset.keep);
        if (choice) controls.append(choice);
      } else controls.append(button('Arkivera', 'archive', { 'case-id': item.id }));
      li.append(controls);
    }
    list.append(li);
  }
  if (!list.childElementCount) list.append(node('li', 'Inga ärenden matchar sökningen. Prova ett annat sökord.'));
  details.append(list);
  if (page) {
    const change = (offset: number) => ({ query: page.query, archived: String(page.archived), offset: String(offset) });
    if (page.offset > 0) details.append(button('Föregående sida', 'history', change(Math.max(0, page.offset - 20))));
    if (page.offset + 20 < page.total) details.append(button('Nästa sida', 'history', change(page.offset + 20)));
  }
  root.replaceChildren(details);
}
