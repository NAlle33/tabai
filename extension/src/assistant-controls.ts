import { node } from './module-views';
import type { ModuleOperation } from '../../shared/personal-modules';
import { assistantSenderDomain } from '../../shared/assistant-web';

export type AssistantAction = (operation: ModuleOperation, input?: Record<string, string>) => Promise<boolean>;
export function button(label: string, action: () => void, className = '') {
  const result = node('button', label, className); result.type = 'button'; result.onclick = action; return result;
}
export function field(label: string, name: string, value: string, multiline: true, namespace?: string): { wrapper: HTMLDivElement; input: HTMLTextAreaElement };
export function field(label: string, name: string, value: string, multiline?: false, namespace?: string): { wrapper: HTMLDivElement; input: HTMLInputElement };
export function field(label: string, name: string, value: string, multiline = false, namespace = '') {
  const wrapper = node('div', '', 'field'), caption = node('label', label);
  const input = multiline ? node('textarea') : node('input');
  input.name = name; input.value = value; input.id = `assistant-${namespace ? `${namespace}-` : ''}${name}`; input.maxLength = multiline ? 12000 : 2000;
  caption.htmlFor = input.id; wrapper.append(caption, input); return { wrapper, input };
}
export function details(label: string, key: string) {
  const result = node('details'); result.dataset.keep = key; result.append(node('summary', label)); return result;
}
export function timestamp(value: string, timezone: string) {
  const time = node('time'); time.dateTime = value;
  try { time.textContent = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'short', timeZone: timezone }).format(new Date(value)); }
  catch { time.textContent = new Date(value).toLocaleString('sv-SE'); }
  return time;
}
export function sourceLink(label: string, value: string) {
  try {
    const url = new URL(value); if (!['https:', 'http:'].includes(url.protocol)) return node('span', label);
    const link = node('a', label); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; return link;
  } catch { return node('span', label); }
}
export function section(heading: string, key: string, description?: string) {
  const result = node('section', '', 'assistant-section'); result.dataset.section = key;
  result.append(node('h3', heading)); if (description) result.append(node('p', description, 'muted'));
  return result;
}

let lookupSequence = 0;
/**
 * "Kolla upp avsändaren" for one mail item. It is disabled, with the reason beside it, when the
 * sender is a private mail service, the details are not loaded here, or web access is off.
 */
export function senderLookup(address: string | undefined, loaded: boolean, webOff: boolean, lookup: () => void) {
  const wrapper = node('div', '', 'assistant-sender-lookup'), control = button('Kolla upp avsändaren', lookup, 'quiet');
  const sender = assistantSenderDomain(address), reason = !loaded ? 'Avsändaren är inte inläst här. Öppna punkten i Mejl för att kolla upp avsändaren.'
    : sender.refusal ?? (webOff ? 'Slå på webbåtkomsten i chatten under Inställningar → Webbåtkomst för att kolla upp avsändaren.' : '');
  control.dataset.senderLookup = 'true'; control.dataset.blocked = String(!!reason); control.disabled = !!reason;
  if (sender.domain) control.title = `Sök efter organisationen bakom ${sender.domain}`;
  wrapper.append(control);
  if (reason) { const note = node('p', reason, 'muted assistant-sender-lookup-reason'); note.id = `assistant-lookup-reason-${++lookupSequence}`; control.setAttribute('aria-describedby', note.id); wrapper.append(note); }
  return wrapper;
}

const gear = (() => {
  const points: string[] = [];
  for (let tooth = 0; tooth < 8; tooth++) {
    const angle = tooth * Math.PI / 4;
    for (const [radius, offset] of [[7.3, -0.42], [9.6, -0.21], [9.6, 0.21], [7.3, 0.42]]) points.push(`${(12 + radius * Math.cos(angle + offset)).toFixed(2)} ${(12 + radius * Math.sin(angle + offset)).toFixed(2)}`);
  }
  return `M${points.join('L')}Z`;
})();
const icons = {
  menu: ['M4 6.5h16', 'M4 12h16', 'M4 17.5h16'],
  back: ['M19 12H5', 'M11 6l-6 6 6 6'],
  settings: [gear, 'M15 12a3 3 0 1 1-6 0a3 3 0 1 1 6 0'],
  mail: ['M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z', 'M3.5 7l8.5 6 8.5-6'],
  plus: ['M12 5v14', 'M5 12h14'],
  send: ['M12 19V5', 'M6 11l6-6 6 6'],
  stop: ['M8 8h8v8H8z'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  more: ['M5.5 12h.01', 'M12 12h.01', 'M18.5 12h.01'],
  chevron: ['M9 6l6 6-6 6'],
  down: ['M7 10l5 5 5-5'],
  attach: ['M20 11.5l-7.8 7.8a4.6 4.6 0 0 1-6.5-6.5l7.8-7.8a3.1 3.1 0 0 1 4.4 4.4l-7.8 7.8a1.5 1.5 0 0 1-2.2-2.2l7.1-7.1'],
  tools: ['M5 5h5v5H5z', 'M14 5h5v5h-5z', 'M5 14h5v5H5z', 'M14 14h5v5h-5z'],
  compose: ['M12 20h8', 'M16.5 3.8a2.1 2.1 0 0 1 3 3L7.5 18.8 4 20l1.2-3.5z'],
  globe: ['M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0', 'M3 12h18', 'M12 3c2.5 2.6 3.6 5.6 3.6 9s-1.1 6.4-3.6 9c-2.5-2.6-3.6-5.6-3.6-9s1.1-6.4 3.6-9z'],
  task: ['M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0', 'M8 12.5l2.7 2.7L16 9.8'],
  tag: ['M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3.5 13.5V3.5h10l7.1 7.1a2 2 0 0 1 0 2.8z', 'M9.5 8a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0'],
} as const;
export type IconName = keyof typeof icons;
/** Decorative stroke icons; the control that holds one carries the accessible name. */
export function icon(name: IconName) {
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false'); svg.classList.add('icon', `icon-${name}`);
  for (const data of icons[name]) { const path = document.createElementNS(ns, 'path'); path.setAttribute('d', data); svg.append(path); }
  return svg;
}
export function iconButton(name: IconName, label: string, action: () => void, className = '') {
  const result = button('', action, `icon-button ${className}`.trim()); result.setAttribute('aria-label', label); result.title = label; result.append(icon(name)); return result;
}

let popoverSequence = 0;
/**
 * A light-dismiss menu in the top layer. The browser closes it on Escape or an outside
 * click and returns focus to the trigger; this only places it next to the trigger.
 */
export function popover(trigger: HTMLButtonElement, panel: HTMLElement, onOpen: () => void = () => {}) {
  panel.id ||= `assistant-popover-${++popoverSequence}`; panel.setAttribute('popover', 'auto'); panel.classList.add('assistant-popover');
  trigger.setAttribute('popovertarget', panel.id); trigger.setAttribute('aria-haspopup', 'true'); trigger.setAttribute('aria-controls', panel.id);
  trigger.onclick = null;
  panel.addEventListener('toggle', event => {
    const open = (event as ToggleEvent).newState === 'open'; trigger.setAttribute('aria-expanded', String(open));
    if (!open) { delete panel.dataset.placed; return; }
    onOpen();
    const anchor = trigger.getBoundingClientRect(), gutter = 8, width = Math.min(panel.offsetWidth, innerWidth - gutter * 2);
    const left = Math.min(Math.max(gutter, anchor.left), innerWidth - width - gutter);
    const below = innerHeight - anchor.bottom, above = anchor.top;
    panel.style.left = `${left}px`; panel.style.maxWidth = `${innerWidth - gutter * 2}px`;
    if (below >= panel.offsetHeight + gutter || below >= above) { panel.style.top = `${anchor.bottom + 4}px`; panel.style.bottom = ''; panel.style.maxHeight = `${below - gutter - 4}px`; }
    else { panel.style.top = ''; panel.style.bottom = `${innerHeight - anchor.top + 4}px`; panel.style.maxHeight = `${above - gutter - 4}px`; }
    panel.dataset.placed = 'true';
    (panel.querySelector<HTMLElement>('input:checked') ?? panel.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)'))?.focus({ preventScroll: true });
  });
  trigger.setAttribute('aria-expanded', 'false');
  return { close: () => { if (panel.matches(':popover-open')) panel.hidePopover(); } };
}
