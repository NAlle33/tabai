import { randomUUID } from "node:crypto";
import * as z from "zod";
import { dateTimeSchema, uuidSchema } from "../shared/stable-schemas";
import type { AssistantItem } from "../shared/assistant";
import { assistantCaseLinkSchema, assistantCaseSchema, CASES_MAX, type AssistantCase, type AssistantCaseLink } from "../shared/assistant-cases";

const editableFields = {
  title: assistantCaseSchema.shape.title.optional(),
  description: z.string().max(2000).optional(), status: assistantCaseSchema.shape.status.optional(),
  nextAction: z.string().max(1000).optional(), waitingFor: z.string().max(300).optional(),
  deadline: z.union([assistantCaseSchema.shape.deadline.unwrap(), z.literal("")]).optional(),
};
const transportFields = { windowId: z.string().optional() };
const caseFields = {
  caseId: uuidSchema.max(36),
  revision: z.string().regex(/^(?:0|[1-9]\d{0,15})$/).refine(value => Number.isSafeInteger(Number(value))),
};
const createInput = z.object({ action: z.literal("case-create"), ...editableFields, ...transportFields }).strict();
const updateInput = z.object({ action: z.literal("case-update"), ...caseFields, ...editableFields, ...transportFields }).strict();
const linkInput = z.object({ action: z.enum(["case-link", "case-unlink"]), ...caseFields, link: z.string().min(1).max(5000), ...transportFields }).strict();
const deleteInput = z.object({ action: z.literal("case-delete"), ...caseFields, ...transportFields }).strict();
const caseInput = z.union([createInput, updateInput, linkInput, deleteInput]);

function linkIdentity(link: AssistantCaseLink): string {
  if (link.kind === "item") return JSON.stringify([link.kind, link.itemId]);
  if (link.kind === "module") return JSON.stringify([link.kind, link.moduleId, link.runId]);
  return JSON.stringify([link.kind, link.url]);
}

function hasLockedSend(entry: AssistantCase, items: AssistantItem[]): boolean {
  return entry.links.some(link => link.kind === "item" && items.some(item => item.id === link.itemId && ["sending", "uncertain"].includes(item.status)));
}

/** Edits explicit case metadata only; linked mail keeps its independent send state. */
export function applyAssistantCaseOperation(cases: AssistantCase[], items: AssistantItem[], input: Record<string, string>, timestamp: string): AssistantCase[] {
  const parsed = caseInput.safeParse(input);
  if (!parsed.success) throw new Error("Ärendeåtgärden innehåller ogiltiga eller saknade uppgifter. Uppdatera panelen och försök igen.");
  const operation = parsed.data;
  if (!dateTimeSchema.safeParse(timestamp).success) throw new Error("Ärendeåtgärden saknar en giltig tidpunkt.");
  if (!z.array(assistantCaseSchema).max(CASES_MAX).safeParse(cases).success) throw new Error("De sparade ärendena kunde inte läsas säkert.");
  if (operation.action === "case-create") {
    if (cases.length >= CASES_MAX) throw new Error(`Högst ${CASES_MAX} ärenden kan sparas. Ta bort ett ärende innan du skapar fler.`);
    if (!operation.title) throw new Error("Ge ärendet en rubrik.");
    const created = assistantCaseSchema.parse({
      id: randomUUID(), revision: 0, title: operation.title, description: operation.description ?? "",
      status: operation.status ?? "open", nextAction: operation.nextAction ?? "", waitingFor: operation.waitingFor ?? "",
      ...(operation.deadline ? { deadline: operation.deadline } : {}), links: [], createdAt: timestamp, updatedAt: timestamp,
    });
    return [...cases, created];
  }
  const index = cases.findIndex(entry => entry.id === operation.caseId);
  if (index < 0) throw new Error("Ärendet finns inte längre. Uppdatera panelen.");
  const current = cases[index];
  if (current.revision !== Number(operation.revision)) throw new Error("Ärendet har ändrats. Läs den senaste versionen innan du fortsätter.");
  if (operation.action === "case-delete") {
    if (hasLockedSend(current, items)) throw new Error("Ärendet har ett pågående eller osäkert utskick. Kontrollera mejltjänsten innan du tar bort ärendet.");
    return cases.filter((_, caseIndex) => caseIndex !== index);
  }
  let changed: AssistantCase;
  if (operation.action === "case-update") {
    if (operation.status === "completed" && hasLockedSend(current, items)) throw new Error("Ärendet har ett pågående eller osäkert utskick. Kontrollera mejltjänsten innan du avslutar ärendet.");
    changed = { ...current };
    for (const key of ["title", "description", "status", "nextAction", "waitingFor"] as const) {
      const value = operation[key];
      if (value !== undefined) Object.assign(changed, { [key]: value });
    }
    if (operation.deadline !== undefined) {
      if (operation.deadline) changed.deadline = operation.deadline;
      else delete changed.deadline;
    }
  } else {
    let value: unknown;
    try { value = JSON.parse(operation.link); } catch { throw new Error("Kopplingen innehåller ogiltiga uppgifter."); }
    const result = assistantCaseLinkSchema.safeParse(value);
    if (!result.success) throw new Error("Kopplingen kräver en giltig punkt, modulreferens eller http-/https-adress utan inloggningsuppgifter.");
    const link = result.data, identity = linkIdentity(link);
    const linked = current.links.some(entry => linkIdentity(entry) === identity);
    if (operation.action === "case-link") {
      if (link.kind === "item" && !items.some(item => item.id === link.itemId)) throw new Error("Punkten finns inte längre i arbetsutrymmet. Uppdatera panelen.");
      if (linked) return cases;
      if (current.links.length >= 100) throw new Error("Högst 100 kopplingar kan sparas i ett ärende. Ta bort en koppling först.");
      changed = { ...current, links: [...current.links, link] };
    } else {
      if (!linked) return cases;
      if (link.kind === "item" && items.some(item => item.id === link.itemId && ["sending", "uncertain"].includes(item.status))) {
        throw new Error("Punkten har ett pågående eller osäkert utskick. Kontrollera först utfallet i mejltjänstens Skickat innan du tar bort kopplingen.");
      }
      changed = { ...current, links: current.links.filter(entry => linkIdentity(entry) !== identity) };
    }
  }
  if (JSON.stringify(changed) === JSON.stringify(current)) return cases;
  if (current.revision === Number.MAX_SAFE_INTEGER) throw new Error("Ärendet kan inte ändras fler gånger. Skapa ett nytt ärende.");
  changed = assistantCaseSchema.parse({ ...changed, revision: current.revision + 1, updatedAt: timestamp });
  return cases.map((entry, caseIndex) => caseIndex === index ? changed : entry);
}
