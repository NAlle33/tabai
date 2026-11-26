import type { ModuleView } from '../../shared/personal-modules';
type Draft = NonNullable<ModuleView['drafts']>['start'];

/** Unsent text travels only to the installed module's private store. */
export class ModuleDrafts {
  private forms = new Map<string, { form: HTMLFormElement; revision: number; pending: Set<Promise<void>>; failed: boolean; status: HTMLElement; retry: HTMLButtonElement }>();
  constructor(private send: (input: Record<string, string>) => Promise<ModuleView>) {}
  attach(form: HTMLFormElement, draft: Draft) {
    const status = document.createElement('p'); status.className = 'muted draft-receipt'; status.setAttribute('role', 'status');
    status.textContent = draft.updatedAt ? 'Sparat på den här datorn.' : '';
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Försök spara texten igen'; retry.hidden = true;
    form.append(status, retry);
    this.forms.set(draft.context, { form, revision: draft.revision, pending: new Set(), failed: false, status, retry });
    form.oninput = () => this.save(draft.context);
    retry.addEventListener('click', () => this.save(draft.context));
  }
  sync(draft: Draft) {
    const entry = this.forms.get(draft.context);
    if (entry && !entry.pending.size) entry.revision = entry.failed ? draft.revision : Math.max(entry.revision, draft.revision);
  }
  private save(context: string) {
    const entry = this.forms.get(context); if (!entry) return;
    const values = Object.fromEntries(new FormData(entry.form).entries()) as Record<string, string>;
    const revision = entry.revision++;
    entry.status.textContent = 'Sparar texten…';
    const pending = this.send({ context, revision: String(revision), values: JSON.stringify(values) }).then(view => {
      const saved = [view.drafts?.start, view.drafts?.reply].find(item => item?.context === context);
      if (!saved) throw new Error('Sparningen kunde inte bekräftas.');
      if (entry.revision === saved.revision) { entry.failed = false; entry.status.textContent = 'Sparat på den här datorn.'; }
    }).catch(() => {
      entry.failed = true; entry.status.textContent = 'Texten kunde inte sparas. Behåll panelen öppen och försök igen.';
    }).finally(() => { entry.pending.delete(pending); entry.retry.hidden = !entry.failed; });
    entry.pending.add(pending);
  }
  async flush() {
    await Promise.all([...this.forms.values()].flatMap(entry => [...entry.pending]));
    if ([...this.forms.values()].some(entry => entry.failed)) throw new Error('Spara den påbörjade texten innan du byter ärende eller fortsätter.');
  }
  forget(context: string) { this.forms.delete(context); }
}
