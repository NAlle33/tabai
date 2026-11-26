import { join } from 'node:path';
import * as z from 'zod';
import { RecipeStore } from './recipe-store';
import { validateAssistantMemory } from './assistant-conversations';
import { ASSISTANT_PROFILE_FIELDS, assistantProfileLabels, assistantProfileSchema, type AssistantProfile } from '../shared/assistant-services';

const stateSchema = z.object({ version: z.literal(1), profile: assistantProfileSchema.optional() }).strict();
type State = z.infer<typeof stateSchema>;

/** A printed card number: one run of 13–19 digits (spaces and dashes allowed) that passes Luhn. */
export function assistantContainsCardNumber(value: string): boolean {
  for (const match of value.matchAll(/\d(?:[ -]?\d)+/g)) {
    const digits = match[0].replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) continue;
    let sum = 0;
    for (let index = 0; index < digits.length; index++) {
      let digit = Number(digits[digits.length - 1 - index]);
      if (index % 2) { digit *= 2; if (digit > 9) digit -= 9; }
      sum += digit;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}
const SECRET_LABEL = /password|lösenord|\bpin\b|pinkod|cvc|cvv|csc|kortnummer|card|kort\s?nr|säkerhetskod|security code|bankid|api.?key|api.?nyckel|token|secret|hemlig|nyckel|private key|otp|engångskod/i;
/** A long unbroken run of letters and digits with no address or name shape: a key or token. */
const KEY_LIKE = (value: string) => /^[A-Za-z0-9_+/=-]{24,}$/.test(value) && /[A-Za-z]/.test(value) && /\d/.test(value);
const PHONE = /^\+?[\d\s().-]{6,24}$/;

/**
 * The checks every saved value passes: no card number, password, key or token,
 * and not the saved Berget key. Email and phone also keep their own shape.
 */
export function validateAssistantProfile(input: unknown, rejectText: (text: string) => void = () => {}): Omit<AssistantProfile, 'updatedAt'> {
  const raw = z.object({
    ...Object.fromEntries(ASSISTANT_PROFILE_FIELDS.map(field => [field, z.string().optional()])),
    extra: z.array(z.object({ label: z.string(), value: z.string() }).strict()).max(6, 'Spara högst sex extra uppgifter.').optional(),
  }).strict().parse(input) as Partial<Record<typeof ASSISTANT_PROFILE_FIELDS[number], string>> & { extra?: { label: string; value: string }[] };
  const profile: Omit<AssistantProfile, 'updatedAt'> = { extra: [] };
  const check = (label: string, value: string) => {
    if (assistantContainsCardNumber(value)) throw new Error(`${label}: kortnummer sparas aldrig i Mina uppgifter. Kortuppgifter fyller du i själv.`);
    if (SECRET_LABEL.test(label) || KEY_LIKE(value)) throw new Error(`${label}: lösenord, koder och nycklar sparas aldrig i Mina uppgifter.`);
    try { validateAssistantMemory({ label, value, scope: 'general' }); } catch { throw new Error(`${label}: lösenord, koder och nycklar sparas aldrig i Mina uppgifter.`); }
    rejectText(`${label}\n${value}`);
  };
  for (const field of ASSISTANT_PROFILE_FIELDS) {
    const value = raw[field]?.replace(/\s+/g, ' ').trim();
    if (!value) continue;
    const label = assistantProfileLabels[field];
    if (field === 'email' && !z.string().email().max(254).safeParse(value).success) throw new Error('E-post: ange en giltig e-postadress.');
    if (field === 'phone' && (!PHONE.test(value) || value.replace(/\D/g, '').length < 6 || value.replace(/\D/g, '').length > 15)) throw new Error('Telefon: ange ett telefonnummer med 6–15 siffror.');
    check(label, value);
    profile[field] = value;
  }
  for (const entry of raw.extra ?? []) {
    const label = entry.label.replace(/\s+/g, ' ').trim(), value = entry.value.replace(/\s+/g, ' ').trim();
    if (!label && !value) continue;
    if (!label || !value) throw new Error('Varje extra uppgift behöver både en etikett och ett värde.');
    check(label, value);
    profile.extra.push({ label, value });
  }
  return assistantProfileSchema.omit({ updatedAt: true }).parse(profile);
}

/**
 * The identifying values of a read profile, normalized for matching: name,
 * street, e-mail, phone digits and extra values. City, country and postal code
 * are left out; they are ordinary search words.
 */
export function assistantProfileValues(value: unknown): string[] {
  const parsed = assistantProfileSchema.safeParse((value as { profile?: unknown } | undefined)?.profile);
  if (!parsed.success) return [];
  const profile = parsed.data, values = [profile.name, profile.street, profile.email, ...profile.extra.map(entry => entry.value)];
  const words = values.flatMap(entry => entry ? [entry.toLocaleLowerCase('sv-SE').replace(/\s+/g, ' ').trim()] : []).filter(entry => entry.length >= 5);
  const digits = (profile.phone ?? '').replace(/\D/g, '');
  return [...words, ...(digits.length >= 8 ? [`#${digits.slice(-8)}`] : [])];
}
/** Text as words: repeated percent-decoding per sequence, '+' and every separator a space, "(at)" an @. */
function profileText(text: string): { words: Set<string>; compact: string; digits: string } {
  let plain = text;
  for (let round = 0; round < 4; round++) {
    const next = plain.replace(/\+/g, ' ').replace(/(?:%[0-9a-f]{2})+/gi, sequence => {
      try { return decodeURIComponent(sequence); } catch { return sequence.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))); }
    });
    if (next === plain) break;
    plain = next;
  }
  const normalized = plain.normalize('NFKC').toLocaleLowerCase('sv-SE').replace(/[([]\s*at\s*[)\]]/g, '@');
  return { words: new Set(normalized.split(/[^\p{L}\p{N}]+/u).filter(word => word.length >= 2)), compact: normalized.replace(/[^\p{L}\p{N}]+/gu, ''), digits: normalized.replace(/\D/g, '') };
}
/**
 * Whether a search, address or search-form value carries one of those values:
 * all of a value's words in any order or separation, the value written without
 * spaces, or a phone number's last eight digits. A heuristic, not a guarantee.
 */
export function assistantContainsProfileValue(text: string, values: string[]): boolean {
  const seen = profileText(text);
  return values.some(value => {
    if (value.startsWith('#')) return seen.digits.includes(value.slice(1));
    const own = profileText(value), words = [...own.words];
    if (words.length && words.some(word => word.length >= 3) && words.every(word => seen.words.has(word))) return true;
    return own.compact.length >= 6 && seen.compact.includes(own.compact);
  });
}

/** Private `profile.json`. Saving or clearing also overwrites the store's backup copy. */
export class AssistantProfileStore {
  private readonly store: RecipeStore<State>;
  private state: State = { version: 1 };
  unavailable?: string;
  constructor(dataDir: string, private readonly rejectText: (text: string) => void = () => {}) {
    this.store = new RecipeStore(join(dataDir, 'profile.json'), value => stateSchema.parse(value));
    try { this.state = this.store.load().state ?? this.state; }
    catch { this.unavailable = 'Mina uppgifter kunde inte läsas säkert. Filen har bevarats.'; }
  }
  /** The saved details, or undefined when nothing is saved. */
  get profile(): AssistantProfile | undefined { return structuredClone(this.state.profile); }
  private async write(next: State): Promise<void> {
    if (this.unavailable) throw new Error(this.unavailable);
    await this.store.save('state', next);
    await this.store.save('state', next);
    this.state = next;
  }
  async save(input: unknown, now = new Date()): Promise<AssistantProfile | undefined> {
    const profile = validateAssistantProfile(input, this.rejectText);
    const empty = !profile.extra.length && ASSISTANT_PROFILE_FIELDS.every(field => !profile[field]);
    await this.write(empty ? { version: 1 } : { version: 1, profile: { ...profile, updatedAt: now.toISOString() } });
    return this.profile;
  }
  async clear(): Promise<void> { await this.write({ version: 1 }); }
}
