import { node } from './module-views';
import { button, field, section, timestamp, type AssistantAction } from './assistant-controls';
import { ASSISTANT_PROFILE_FIELDS, assistantProfileLabels, type AssistantProfile } from '../../shared/assistant-services';
import type { AssistantChatView } from '../../shared/assistant-chat';

const autocomplete = { name: 'name', street: 'street-address', postalCode: 'postal-code', city: 'address-level2', country: 'country-name', phone: 'tel', email: 'email' } as const;
const EXTRA_LIMIT = 6;
let sequence = 0;

/** Inställningar → Minne → Mina uppgifter. Unsaved text survives polling until it is saved or cleared. */
export class AssistantProfileSettings {
  readonly element = section('Mina uppgifter', 'profile', 'Uppgifterna används bara när agenten fyller i ett formulär åt dig på nivån Agera med godkännande under Webbåtkomst. De skickas inte med i vanliga samtal. När agenten läser dem går de till leverantören av den chattmodell du valt (OpenAI, Anthropic eller Berget); med en lokal modell stannar de på datorn. Tabai stoppar sökningar, adresser och sökfält som innehåller dem, men kontrollen är en tumregel och kan missa omskrivna värden.');
  private namespace = `profile-${++sequence}`;
  private form = node('form', '', 'assistant-profile-form');
  private fields = new Map<string, HTMLInputElement>();
  private extras = node('div', '', 'assistant-profile-extras');
  private addExtra = button('Lägg till en egen uppgift', () => { this.addRow(); this.markDirty(); this.extras.lastElementChild?.querySelector('input')?.focus(); });
  private save = node('button', 'Spara mina uppgifter', 'primary');
  private clear = button('Rensa mina uppgifter', () => void this.clearProfile());
  private status = node('p', '', 'muted assistant-profile-status');
  private updated = node('p', '', 'muted');
  private error = node('p', '', 'module-error');
  private dirty = false;
  private version = 0;
  private key = '';
  private busy = false;
  private profile?: AssistantProfile;
  constructor(private act: AssistantAction, private changed: () => void = () => {}) {
    this.status.setAttribute('role', 'status'); this.error.setAttribute('role', 'alert');
    this.element.append(node('p', 'Lösenord, kortnummer, koder och BankID sparas aldrig här. Dem fyller du alltid i själv.', 'notice assistant-profile-never'), this.error);
    for (const name of ASSISTANT_PROFILE_FIELDS) {
      const control = field(assistantProfileLabels[name], `profile-${name}`, '', false, this.namespace);
      control.input.autocomplete = autocomplete[name]; control.input.maxLength = name === 'email' ? 254 : name === 'postalCode' ? 20 : name === 'phone' ? 40 : 200;
      if (name === 'email') control.input.type = 'email';
      if (name === 'phone') control.input.type = 'tel';
      control.input.dataset.profileField = name; this.fields.set(name, control.input); this.form.append(control.wrapper);
    }
    const extras = node('fieldset', '', 'assistant-profile-extra'); extras.append(node('legend', 'Egna uppgifter'), node('p', `Till exempel kundnummer eller företagsnamn. Högst ${EXTRA_LIMIT}.`, 'muted'), this.extras, this.addExtra);
    this.save.type = 'submit';
    const actions = node('div', '', 'assistant-actions'); actions.append(this.save, this.clear);
    this.form.append(extras, actions, this.status, this.updated);
    this.form.oninput = () => this.markDirty(); this.form.onchange = this.form.oninput;
    this.form.onsubmit = event => { event.preventDefault(); void this.saveProfile(); };
    this.element.append(this.form);
  }
  get unsaved() { return this.dirty; }
  private markDirty() { this.dirty = true; this.version++; this.status.textContent = 'Du har osparade ändringar.'; this.form.dataset.dirty = 'true'; this.controls(); this.changed(); }
  private controls() {
    const rows = this.extras.childElementCount;
    this.addExtra.dataset.blocked = String(this.busy || rows >= EXTRA_LIMIT); this.addExtra.disabled = this.addExtra.dataset.blocked === 'true';
    this.save.dataset.blocked = String(this.busy); this.save.disabled = this.busy;
    this.clear.dataset.blocked = String(this.busy || (!this.profile && !this.dirty)); this.clear.disabled = this.clear.dataset.blocked === 'true';
  }
  update(view?: AssistantChatView) {
    this.profile = view?.profile;
    this.error.textContent = view?.profileError ?? ''; this.error.hidden = !this.error.textContent;
    const key = JSON.stringify(view?.profile ?? null);
    if (!this.dirty && key !== this.key) { this.key = key; this.fill(view?.profile); }
    this.controls();
  }
  private fill(profile?: AssistantProfile) {
    for (const [name, input] of this.fields) input.value = (profile?.[name as keyof AssistantProfile] as string | undefined) ?? '';
    this.extras.replaceChildren(); for (const entry of profile?.extra ?? []) this.addRow(entry.label, entry.value);
    this.updated.replaceChildren();
    if (profile?.updatedAt) { this.updated.append(document.createTextNode('Senast sparade: ')); this.updated.append(timestamp(profile.updatedAt, 'Europe/Stockholm')); }
  }
  private addRow(label = '', value = '') {
    const index = this.extras.childElementCount, row = node('div', '', 'assistant-profile-row'); row.dataset.profileExtra = 'true';
    const name = field('Uppgift', `profile-extra-label-${index}`, label, false, this.namespace), content = field('Värde', `profile-extra-value-${index}`, value, false, this.namespace);
    name.input.maxLength = 60; content.input.maxLength = 300; name.input.dataset.extra = 'label'; content.input.dataset.extra = 'value';
    row.append(name.wrapper, content.wrapper, button('Ta bort', () => { row.remove(); this.markDirty(); }, 'quiet'));
    this.extras.append(row); this.controls();
  }
  private async saveProfile() {
    if (this.busy || !this.form.reportValidity()) return;
    const input: Record<string, string> = { action: 'profile-save' };
    for (const [name, control] of this.fields) input[name] = control.value.trim();
    input.extra = JSON.stringify([...this.extras.querySelectorAll<HTMLElement>('[data-profile-extra]')].map(row => ({ label: row.querySelector<HTMLInputElement>('[data-extra="label"]')!.value.trim(), value: row.querySelector<HTMLInputElement>('[data-extra="value"]')!.value.trim() })).filter(entry => entry.label || entry.value));
    const version = this.version; this.busy = true; this.status.textContent = 'Sparar mina uppgifter…'; this.controls();
    const ok = await this.act('correct', input); this.busy = false;
    // The acknowledged view already arrived during the save; show exactly what was stored.
    if (ok && version === this.version) { this.dirty = false; delete this.form.dataset.dirty; this.key = JSON.stringify(this.profile ?? null); this.fill(this.profile); this.status.textContent = 'Mina uppgifter är sparade privat på datorn.'; }
    else if (ok) this.status.textContent = 'Uppgifterna sparades. Dina senaste ändringar är fortfarande osparade.';
    else this.status.textContent = 'Uppgifterna kunde inte sparas. Texten finns kvar.';
    this.controls(); this.changed();
  }
  private async clearProfile() {
    if (this.busy || !window.confirm('Rensa mina uppgifter? Alla sparade fält tas bort från datorn.')) return;
    this.busy = true; this.controls();
    const ok = await this.act('correct', { action: 'profile-clear' }); this.busy = false;
    if (ok) { this.dirty = false; delete this.form.dataset.dirty; this.key = JSON.stringify(this.profile ?? null); this.fill(this.profile); this.status.textContent = 'Mina uppgifter är borttagna.'; }
    else this.status.textContent = 'Uppgifterna kunde inte tas bort.';
    this.controls(); this.changed();
  }
}
