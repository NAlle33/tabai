import * as z from "zod";

/** Counts only: notification transport never carries mailbox text or addresses. */
export const assistantNoticeSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/), count: z.number().int().min(0).max(100),
  critical: z.number().int().min(0).max(100), desktop: z.boolean(),
  /** A watch hit gets its own fixed text; still no watch title, page or mailbox text. */
  kind: z.enum(['mail', 'watch', 'routine']).optional(),
  /** A watch notice without it is a hit; `paused` says a watch paused itself after failed runs. */
  watchEvent: z.literal('paused').optional(),
  /** A routine notice without it says the routine is done; `paused` says it paused itself after failed runs. */
  routineEvent: z.literal('paused').optional(),
  /** The user's own name for the routine, for its fixed text; never the routine's question or its answer. */
  routineTitle: z.string().trim().min(1).max(120).optional(),
}).strict().superRefine((notice, context) => {
  if (notice.watchEvent && notice.kind !== 'watch') context.addIssue({ code: 'custom', message: 'A watch event belongs to a watch notice' });
  if ((notice.routineEvent || notice.routineTitle) && notice.kind !== 'routine') context.addIssue({ code: 'custom', message: 'A routine field belongs to a routine notice' });
  if (notice.kind === 'routine' && !notice.routineTitle) context.addIssue({ code: 'custom', message: 'A routine notice names its routine' });
});
export type AssistantNotice = z.infer<typeof assistantNoticeSchema>;
