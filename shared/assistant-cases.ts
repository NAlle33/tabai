import * as z from "zod";
import { dateTimeSchema, uuidSchema } from "./stable-schemas";

export const CASES_MAX = 100;

const sourceId = z.string().min(1).max(100);
const label = z.string().max(300).default("");
const safeUrl = z.string().min(1).max(2000).refine(value => {
  if (!/^https?:\/\/[^/?#]+/i.test(value) || /[\s\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    const authority = value.match(/^https?:\/\/([^/?#]+)/i)?.[1];
    return ["http:", "https:"].includes(url.protocol) && !!url.hostname && !url.username && !url.password && !authority?.includes("@");
  } catch { return false; }
}, "Ange en giltig http- eller https-adress utan inloggningsuppgifter.").transform(value => new URL(value).href);

export const assistantCaseLinkSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("item"), itemId: sourceId }).strict(),
  // The module ID pattern matches personal-modules without importing its workspace schema.
  z.object({ kind: z.literal("module"), moduleId: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/), runId: sourceId, label }).strict(),
  z.object({ kind: z.literal("url"), url: safeUrl, label }).strict(),
]);
export type AssistantCaseLink = z.infer<typeof assistantCaseLinkSchema>;

const deadline = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Ange ett giltigt datum som ÅÅÅÅ-MM-DD.");

export const assistantCaseSchema = z.object({
  id: uuidSchema, revision: z.number().int().nonnegative().safe(),
  title: z.string().trim().min(1).max(200), description: z.string().max(2000).default(""),
  status: z.enum(["open", "waiting", "completed"]),
  nextAction: z.string().max(1000).default(""), waitingFor: z.string().max(300).default(""),
  deadline: deadline.optional(), links: z.array(assistantCaseLinkSchema).max(100),
  createdAt: dateTimeSchema, updatedAt: dateTimeSchema,
}).strict();
export type AssistantCase = z.infer<typeof assistantCaseSchema>;
