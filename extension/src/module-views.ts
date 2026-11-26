import type { ModuleView, ModuleOperation } from "../../shared/personal-modules";
import type { ModuleDrafts } from "./module-drafts";
import { renderModuleReview } from "./module-review";

export function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") {
  const element = document.createElement(tag); element.textContent = text; element.className = className; return element;
}

function safeUrl(value: string): string | undefined {
  try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined; } catch { return; }
}
export function renderModuleStart(id: string, view: ModuleView, form: HTMLFormElement, drafts: ModuleDrafts, onStart: (input: Record<string, string>) => Promise<void>) {
  const details = node("details"); details.open = !view.run; details.append(node("summary", "Nytt uppdrag"));
  const advanced = node('details'); advanced.append(node('summary', 'Fler alternativ'));
  for (const field of view.fields) {
    const wrapper = node("div", "", "field"), label = node("label", field.label);
    const input = field.multiline ? node("textarea") : node("input");
    input.id = `module-${id}-${field.name}`; input.name = field.name;
    input.required = !!field.required; input.value = view.drafts?.start.values[field.name] ?? field.value ?? ""; input.placeholder = field.placeholder ?? "";
    input.maxLength = 20000; label.htmlFor = input.id; wrapper.append(label, input); (field.advanced ? advanced : details).append(wrapper);
  }
  if (view.fields.some(field => field.advanced)) details.append(advanced);
  const start = node("button", view.startLabel, "primary"); start.type = "submit";
  details.append(start); form.append(details);
  if (view.drafts) drafts.attach(form, view.drafts.start);
  form.onsubmit = event => {
    event.preventDefault(); if (!form.reportValidity()) return;
    void onStart(Object.fromEntries(new FormData(form).entries()) as Record<string, string>);
  };
}

type ModuleRun = NonNullable<ModuleView['run']>;

/**
 * Arkivera as the module allows it for a working or blocked run: its reason why not, or a
 * confirmed stop-and-archive. Undefined when the module offers neither. The confirmation is a
 * kept `details`, so a poll's re-render leaves it open.
 */
export function archiveChoice(run: Pick<ModuleRun, 'id' | 'status' | 'stopAndArchive' | 'archiveBlocked'>, act: (operation: ModuleOperation, input: Record<string, string>) => unknown) {
  if (run.archiveBlocked) return node('p', run.archiveBlocked, 'muted module-archive-blocked');
  if (run.status !== 'running' || !run.stopAndArchive) return undefined;
  const confirm = node('details', '', 'module-archive-confirm'); confirm.dataset.keep = `archive-${run.id}`;
  const yes = node('button', 'Ja, avbryt och arkivera'); yes.type = 'button';
  yes.addEventListener('click', () => void act('archive', { 'case-id': run.id }));
  confirm.append(node('summary', 'Avbryt och arkivera'), node('p', 'Arbetet stoppas efter pågående steg och ärendet arkiveras. Det finns kvar under Tidigare ärenden.', 'muted'), yes);
  return confirm;
}

function messageForm(run: ModuleRun, act: (operation: ModuleOperation, input: Record<string, string>) => Promise<boolean>) {
  const form = node('form'), label = node('label', 'Ställ en fråga eller beskriv en ändring'), input = node('textarea'), submit = node('button', 'Skicka');
  form.dataset.runMessage = run.id; input.name = 'message'; input.id = `module-message-${run.id}`; input.required = true; input.maxLength = 8000; label.htmlFor = input.id; submit.type = 'submit';
  form.append(label, input, submit);
  form.addEventListener('submit', event => {
    event.preventDefault(); if (!form.reportValidity()) return;
    // One send per user action with a fresh ID; a lost reply is never retried.
    const text = input.value;
    void act('message', { 'run-id': run.id, 'message-id': crypto.randomUUID(), message: text }).then(sent => { if (sent && input.value === text) input.value = ''; });
  });
  return form;
}

function renderRunChat(run: ModuleRun, previousState: HTMLElement, act: (operation: ModuleOperation, input: Record<string, string>) => Promise<boolean>, chatAbout?: (runId: string) => void) {
  const section = node('section', '', 'module-chat'); section.setAttribute('aria-label', 'Skriv till agenten');
  section.append(node('h3', 'Skriv till agenten'));
  if (run.conversation?.length) {
    const log = node('ol', '', 'module-chat-log');
    for (const entry of run.conversation) { const item = node('li', entry.text); item.dataset.role = entry.role; log.append(item); }
    section.append(log);
  }
  const previous = previousState.querySelector<HTMLFormElement>('form[data-run-message]');
  const form = previous?.dataset.runMessage === run.id ? previous : messageForm(run, act);
  form.querySelector('button')!.disabled = run.messaging === 'busy';
  section.append(form);
  if (run.messaging === 'busy') section.append(node('p', 'Agenten arbetar. Du kan skriva igen när den är klar.', 'muted'));
  if (chatAbout) { const open = node('button', 'Chatta om ärendet'); open.type = 'button'; open.onclick = () => chatAbout(run.id); section.append(open); }
  return section;
}

export function renderModuleContent(id: string, view: ModuleView, previousState: HTMLElement, drafts: ModuleDrafts, act: (operation: ModuleOperation, input: Record<string, string>) => Promise<boolean>, chatAbout?: (runId: string) => void): HTMLElement[] {
  const content: HTMLElement[] = [node('p', 'Personligt', 'muted'), node('h2', view.title)];
  if (!view.run) content.push(node('p', view.description, 'muted'));
  if (view.run) {
    const run = view.run, status = node("p", run.message, "run-status"); status.setAttribute("role", "status");
    if (run.title) content.push(node('p', run.title, 'module-case-title'));
    const next = node('section', '', 'module-next-action'); next.setAttribute('aria-label', 'Nästa steg');
    if (run.actionLabel) next.append(node('h3', run.actionLabel)); next.append(status); content.push(next);
    if (run.replyReceivedAt) {
      const receipt = node("p", "Ditt svar är mottaget ", "module-receipt");
      const time = node("time", new Date(run.replyReceivedAt).toLocaleTimeString("sv-SE")); time.dateTime = run.replyReceivedAt;
      receipt.append(time); receipt.setAttribute("role", "status"); next.append(receipt);
    }
    if (run.step) next.append(node("p", `Aktuellt steg: ${run.step}`, "module-step"));
    if (run.updatedAt) {
      const updated = node("p", "Senast uppdaterad: ", "muted module-updated");
      const time = node("time", new Date(run.updatedAt).toLocaleString("sv-SE")); time.dateTime = run.updatedAt;
      updated.append(time); next.append(updated);
    }
    if (run.review) content.push(renderModuleReview(run.review, run.canCorrect ? async (field, value) => { await act('correct', { 'run-id': run.id, field, value }); } : undefined));
    if (run.summary) { const details = node('details'); details.dataset.keep = 'work'; details.append(node('summary', 'Arbetets sammanfattning'), node('p', run.summary, 'module-summary')); content.push(details); }
    if (run.sources?.length) {
      const sources = node("details"), list = node("ul"); sources.dataset.keep = 'sources'; sources.append(node("summary", "Visa underlag"));
      for (const source of run.sources) {
        const item = node("li"), href = safeUrl(source.url);
        if (href) { const link = node("a", source.label); link.href = href; link.target = "_blank"; link.rel = "noopener noreferrer"; item.append(link); }
        else item.textContent = source.label;
        list.append(item);
      }
      sources.append(list); content.push(sources);
    }
    const button = (label: string, operation: ModuleOperation) => {
      const result = node("button", label); result.type = "button";
      result.addEventListener("click", () => void act(operation, { "run-id": run.id })); return result;
    };
    if (run.canOpen && run.question) { const open = button(run.openLabel || 'Öppna i webbläsaren', 'open'); open.className = 'primary'; next.append(open); }
    if (run.question) {
      const questionKey = `${run.id}:${run.questionId || run.question}`;
      const previousForm = previousState.querySelector<HTMLFormElement>('form[data-question]');
      if (previousForm?.dataset.question === questionKey) next.append(previousForm);
      else {
      const form = node("form"), label = node("label", run.question), input = node("textarea"); form.dataset.question = questionKey;
      input.required = true; input.maxLength = 20000; input.name = "answer";
      input.value = view.drafts?.reply?.values.answer || '';
      input.id = `module-answer-${id}`; label.htmlFor = input.id;
      const reply = (answer: string) => act('reply', { 'run-id': run.id, ...(run.questionId ? { 'question-id': run.questionId } : {}), answer });
      form.append(label);
      if (run.choices?.length) {
        const choices = node('div', '', 'module-choices');
        for (const choice of run.choices) { const quick = node('button', choice.label); quick.type = 'button'; quick.onclick = () => void reply(choice.value); choices.append(quick); }
        form.append(choices, node('p', 'Eller skriv ett eget svar:', 'muted'));
      }
      const submit = node("button", "Svara och fortsätt", run.choices?.length ? '' : 'primary'); submit.type = "submit"; form.append(input, submit);
      form.addEventListener("submit", event => { event.preventDefault(); if (form.reportValidity()) void reply(input.value); });
      if (view.drafts?.reply) drafts.attach(form, view.drafts.reply);
      next.append(form);
      }
    }
    if (run.status === "running" && run.canStop !== false) next.append(button("Stoppa efter pågående åtgärd", "stop"));
    if (run.canResume && !run.question) { const resume = button(run.resumeLabel || 'Fortsätt ärendet', 'resume'); resume.className = 'primary'; next.append(resume); }
    if (run.canOpen && !run.question) { const open = button(run.openLabel || 'Öppna i webbläsaren', 'open'); if (!run.canResume) open.className = 'primary'; next.append(open); }
    if (run.archived) { const restore = node('button', 'Återställ ärendet'); restore.onclick = () => void act('restore', { 'case-id': run.id }); next.append(restore); }
    else if (run.archiveBlocked || run.status === 'running') { const choice = archiveChoice(run, act); if (choice) next.append(choice); }
    else if (view.historyPage && run.archived === false) {
      const archive = node('button', 'Arkivera ärendet'); archive.type = 'button';
      archive.onclick = () => void act('archive', { 'case-id': run.id });
      next.append(archive, node('p', 'Döljer kortet. Ärendet finns kvar under Tidigare ärenden.', 'muted'));
    }
    if (run.messaging) content.splice(content.indexOf(next) + 1, 0, renderRunChat(run, previousState, act, chatAbout));
  }
  return content;
}
