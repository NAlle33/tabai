import { createPanelClient } from "./panel-client";
import { node, renderModuleStart, renderModuleContent } from "./module-views";
import type { ModuleOperation, ModuleView, PersonalModule } from "../../shared/personal-modules";
import { ModuleDrafts } from './module-drafts';
import { renderModuleHistory } from './module-history';
import { AssistantPanel } from './assistant-panel';

const request = createPanelClient({ timeoutMs: 10000, timeoutMessage: "Svarstiden gick ut.", missingReplyMessage: "Ingen anslutning till lokala moduler.", errorFallback: "Ingen anslutning till lokala moduler." });

const root = document.getElementById("personal-modules")!;
const cards = new Map<string, { element: HTMLElement; form: HTMLFormElement; state: HTMLElement; history: HTMLElement; feedback: HTMLElement; key: string; busy: boolean; drafts: ModuleDrafts; view?: ModuleView; assistant?: AssistantPanel }>();
let viewGeneration = 0;
let activeAssistantHostId: string | undefined;
function activateModuleHost(id?: string) {
  const assistant = id ? cards.get(id)?.assistant : undefined;
  activeAssistantHostId = assistant ? id : undefined;
  // A generic card is one live DOM tree. Only its current host may hide or select it.
  for (const card of cards.values()) if (card.assistant && card.assistant !== assistant) card.assistant.detachModules();
  for (const [moduleId, card] of cards) if (!card.assistant) {
    if (assistant) assistant.attachModule(moduleId, card.element);
    else { card.element.hidden = false; if (card.element.parentElement !== root) root.append(card.element); }
  }
}
export async function flushAssistantDrafts() {
  for (const card of cards.values()) if (card.assistant && !await card.assistant.flushDrafts()) return false;
  return true;
}
async function act(id: string, operation: ModuleOperation, input: Record<string, string> = {}) {
  const card = cards.get(id)!;
  if (card.busy) return false;
  let succeeded = false;
  viewGeneration++;
  card.busy = true; card.feedback.textContent = "";
  // Every button of the card goes off first; an assistant then applies its own rules, which keep the
  // ✕ of a file on its way up usable, so an upload can be cancelled while another action runs.
  card.element.querySelectorAll<HTMLButtonElement>("button").forEach(button => { if (button.closest('[data-module-id]') === card.element) button.disabled = true; });
  card.assistant?.setBusy(true);
  try {
    if (card.assistant) {
      // Resolve from this panel document, before any asynchronous draft flush.
      // A worker's last-focused window can belong to a different panel/task.
      const windowId = (await chrome.windows.getCurrent()).id;
      if (!Number.isInteger(windowId) || windowId! < 0) throw new Error("Panelens Chrome-fönster kunde inte hittas. Öppna panelen igen.");
      input = { ...input, windowId: String(windowId) };
    }
    if (!card.assistant && !['stop', 'open', 'history'].includes(operation)) await card.drafts.flush();
    const view = await request({ action: "module", moduleId: id, operation, input }) as ModuleView;
    if (operation === 'start' && view.drafts && !Object.keys(view.drafts.start.values).length) { card.form.replaceChildren(); card.drafts.forget('start'); }
    card.key = ""; card.busy = false; render({ id, view }); succeeded = true;
  } catch (error) {
    card.feedback.textContent = `${String(error)} Status hämtas igen; åtgärden upprepas inte automatiskt.`;
    card.busy = false; card.key = "";
  }
  card.assistant?.setBusy(false);
  viewGeneration++;
  void poll(true);
  return succeeded;
}
/**
 * One step inside an action the card already shows, such as one chunk of an upload. It goes
 * through the host's queue like any request, but the card is not marked busy, its answer is not
 * drawn and no poll follows; the host answers it with its smallest view. A failed step is shown
 * like a failed action, and the caller reports it in its own row.
 */
async function quietly(id: string, operation: ModuleOperation, input: Record<string, string> = {}) {
  const card = cards.get(id);
  if (!card) return false;
  try { await request({ action: "module", moduleId: id, operation, input: { ...input, quiet: "true" } }); return true; }
  catch (error) {
    card.feedback.textContent = `${String(error)} Status hämtas igen; åtgärden upprepas inte automatiskt.`;
    void poll(true);
    return false;
  }
}
/**
 * Fill only the start fields the module named for a mail, open them, and save them as the
 * module's own start draft through the form's input handler. Nothing is started.
 */
function fillStart(card: { form: HTMLFormElement; view?: ModuleView }, values: Record<string, string>) {
  const mailStart = card.view?.mailStart;
  if (!mailStart || !card.form.childElementCount) return 'Verktyget kan inte starta från ett mejl. Uppdatera panelen och försök igen.';
  const names = [mailStart.mailField, mailStart.accountField, mailStart.linkField, ...(mailStart.clearFields ?? [])].filter(Boolean);
  for (const [name, value] of Object.entries(values)) {
    const input = names.includes(name) ? card.form.elements.namedItem(name) : null;
    if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) continue;
    input.value = value;
    for (let details = input.closest('details'); details; details = details.parentElement?.closest('details') ?? null) details.open = true;
  }
  card.form.querySelector('details')!.open = true;
  card.form.dispatchEvent(new Event('input', { bubbles: true }));
  return undefined;
}
function render(module: PersonalModule) {
  let card = cards.get(module.id);
  if (!card) {
    const element = node("article", "", "personal-module"), form = node("form"), state = node("div"), history = node('div');
    const feedback = node("p", "", "module-error"); feedback.setAttribute("role", "alert");
    element.dataset.moduleId = module.id; element.append(state, form, history, feedback); root.append(element);
    card = { element, form, state, history, feedback, key: "", busy: false,
      drafts: new ModuleDrafts(input => request({ action: 'module', moduleId: module.id, operation: 'draft', input }) as Promise<ModuleView>) }; cards.set(module.id, card);
  }
  if (card.busy) return;
  if (module.error || !module.view) {
    card.key = "";
    card.feedback.textContent = module.error ?? "Modulen är inte tillgänglig.";
    card.element.querySelectorAll<HTMLButtonElement>("button").forEach(button => { if (button.closest('[data-module-id]') === card.element) button.disabled = true; }); return;
  }
  const view = module.view;
  if (view.assistant) {
    card.form.hidden = true; card.history.hidden = true; card.element.classList.add('assistant-module');
    if (!card.assistant) {
      card.assistant = new AssistantPanel(card.state, (operation, input) => act(module.id, operation, input), async (id, runId, start) => {
        if (!await flushAssistantDrafts()) return 'Svarsförslaget kunde inte sparas. Spara utkastet innan du öppnar modulkörningen.';
        const source = cards.get(id); if (!source) return 'Den lokala modulen är inte tillgänglig. Kontrollera anslutningen och uppdatera panelen.';
        if (source.busy) return 'Modulen arbetar redan. Vänta tills åtgärden är klar och öppna körningen igen.';
        // A run that is already the module's current one needs no select, which a module may refuse while it works.
        if (runId && source.view?.run?.id !== runId && !await act(id, 'select', { 'case-id': runId })) return source.feedback.textContent || 'Modulkörningen kunde inte öppnas. Kontrollera modulens anslutning.';
        if (runId && source.view?.run?.id !== runId) {
          source.feedback.textContent = 'Modulen visade inte den valda körningen. Referensen kan inte öppnas i den aktuella modulen.';
          return source.feedback.textContent;
        }
        if (!await card!.assistant!.selectModule(id)) return 'Svarsförslaget kunde inte sparas. Spara utkastet innan du öppnar modulen.';
        if (start) { const error = fillStart(source, start); if (error) return error; }
        source.element.scrollIntoView({ block: 'start' });
        const submit = source.form.querySelector<HTMLButtonElement>('button[type="submit"]');
        const target = start ? (submit && !submit.disabled ? submit : source.form.querySelector<HTMLElement>(`[name="${CSS.escape(source.view!.mailStart!.mailField)}"]`))
          : source.state.querySelector<HTMLElement>('textarea[name="answer"]') || source.state.querySelector<HTMLElement>('h2');
        if (target) { if (target.tagName === 'H2') target.tabIndex = -1; target.focus({ preventScroll: true }); }
      }, module.id, () => activateModuleHost(module.id),
      // An approval card's image is a read of its own, never an action: it does not block the card's buttons.
      async (fileId, offset) => (await request({ action: 'module', moduleId: module.id, operation: 'status', input: { chatPreview: fileId, previewOffset: String(offset) } }) as ModuleView).chat?.preview,
      (operation, input) => quietly(module.id, operation, input));
      root.prepend(card.element);
    }
    card.view = view;
    // Older modules without local runtime status still render unchanged.
    const key = JSON.stringify([view.assistant, view.localRuntime ?? null, view.chat ?? null]);
    if (key !== card.key) { card.key = key; card.assistant.update(view.assistant, view.localRuntime, view.chat); }
    return;
  }
  const clearedRun = !!card.view?.run && !view.run;
  const previousReply = card.view?.drafts?.reply;
  if (previousReply && previousReply.context !== view.drafts?.reply?.context) card.drafts.forget(previousReply.context);
  const focused = card.element.contains(document.activeElement) ? document.activeElement as HTMLElement : undefined;
  // A confirmation is rebuilt on every re-render; focus returns to the same part of the new one.
  const keptFocus = focused && ['SUMMARY', 'BUTTON'].includes(focused.tagName) ? focused.closest<HTMLElement>('details[data-keep]')?.dataset.keep : undefined;
  const keptPart = focused?.tagName === 'SUMMARY' ? 'summary' : 'button', keptIn = focused && card.history.contains(focused) ? card.history : card.state;
  const unsentCorrections = card.view?.run?.id === view.run?.id
    ? [...card.state.querySelectorAll<HTMLInputElement>('input[data-field]')].map(input => ({ field: input.dataset.field, value: input.value, initial: input.defaultValue })) : [];
  card.view = view;
  if (view.drafts) { card.drafts.sync(view.drafts.start); if (view.drafts.reply) card.drafts.sync(view.drafts.reply); }
  if (!card.form.childElementCount) {
    renderModuleStart(module.id, view, card.form, card.drafts, async input => { await act(module.id, "start", input); });
  }
  if (clearedRun) card.form.querySelector<HTMLDetailsElement>('details')!.open = true;
  const key = JSON.stringify({ ...view, drafts: undefined }); if (key === card.key) return; card.key = key;
  card.element.querySelectorAll<HTMLButtonElement>('button').forEach(button => button.disabled = false);
  card.form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled = view.run?.status === "running";
  const chatAbout = [...cards.values()].some(entry => entry.assistant) ? (runId: string) => void cards.get(activeAssistantHostId ?? '')?.assistant?.chatAboutModule(module.id, runId) : undefined;
  const content = renderModuleContent(module.id, view, card.state, card.drafts, (operation, input) => act(module.id, operation, input), chatAbout);
  const openDetails = new Set([...card.state.querySelectorAll<HTMLDetailsElement>('details[open][data-keep]')].map(detail => detail.dataset.keep));
  card.state.replaceChildren(...content);
  card.state.querySelectorAll<HTMLInputElement>('input[data-field]').forEach(input => {
    const previous = unsentCorrections.find(item => item.field === input.dataset.field && item.initial === input.defaultValue);
    if (previous) input.value = previous.value;
  });
  card.state.querySelectorAll<HTMLDetailsElement>('details[data-keep]').forEach(detail => { detail.open = openDetails.has(detail.dataset.keep); });
  renderModuleHistory(card.history, view, async (operation, input) => { await act(module.id, operation, input); });
  if (focused?.isConnected) focused.focus({ preventScroll: true });
  else if (keptFocus) keptIn.querySelector<HTMLElement>(`details[data-keep="${CSS.escape(keptFocus)}"] ${keptPart}`)?.focus({ preventScroll: true });
}
let polling = false;
async function poll(force = false) {
  if (polling || (!force && document.hidden)) return; polling = true;
  const generation = viewGeneration;
  try {
    const modules = await request({ action: "modules" }) as PersonalModule[];
    if (generation !== viewGeneration) return;
    for (const module of modules) render(module);
    const pending = modules.flatMap(module => {
      const view = module.view, run = view?.run;
      return !view?.assistant && run && !run.archived && (run.question || run.status === 'review')
        ? [{ id: module.id, title: run.title || view!.title, question: run.question, message: run.message }] : [];
    });
    for (const [id, card] of cards) if (!modules.some(module => module.id === id)) { card.assistant?.dispose(); card.element.remove(); cards.delete(id); }
    const hosts = modules.filter(module => module.view?.assistant && !module.error && cards.get(module.id)?.assistant);
    activateModuleHost(hosts.find(module => module.id === activeAssistantHostId)?.id ?? hosts[0]?.id);
    for (const card of cards.values()) if (card.assistant) { card.assistant.setPendingModules(pending); card.assistant.setCaseModules(modules); }
    root.hidden = !modules.length;
  } catch {
    if (generation !== viewGeneration) return;
    for (const card of cards.values()) {
      card.feedback.textContent = "Modulen är frånkopplad. Öppna anslutningsinställningarna."; card.key = "";
      card.element.querySelectorAll<HTMLButtonElement>("button").forEach(button => { if (button.closest('[data-module-id]') === card.element) button.disabled = true; });
    }
  } finally { polling = false; }
}
if (typeof chrome !== "undefined" && chrome.runtime?.id) {
  void poll(); setInterval(() => void poll(), 2000);
  document.addEventListener("visibilitychange", () => void poll());
  window.addEventListener("focus", () => void poll(true));
  window.addEventListener("pageshow", () => void poll(true));
  document.getElementById("refresh")?.addEventListener("click", () => void poll(true));
}
