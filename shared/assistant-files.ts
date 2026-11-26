import * as z from 'zod';
import { uuidSchema } from './stable-schemas';

export const ASSISTANT_FILE_BYTES = 10 * 1024 * 1024;
export const ASSISTANT_FILE_CHUNK = 48 * 1024;
export const ASSISTANT_FILE_TEXT = 500_000;
export const ASSISTANT_FILES_PER_MESSAGE = 5;
/** An approval card's image: a JPEG or PNG of at most one megabyte. */
export const ASSISTANT_APPROVAL_IMAGE_BYTES = 1024 * 1024;
/** Base64 characters per piece of an approval image the panel fetches; a multiple of four. */
export const ASSISTANT_APPROVAL_IMAGE_CHUNK = 192 * 1024;
export const assistantFileKindSchema = z.enum(['text', 'pdf', 'docx', 'image']);
export type AssistantFileKind = z.infer<typeof assistantFileKindSchema>;
export const assistantFileSchema = z.object({
  id: uuidSchema, name: z.string().min(1).max(255), kind: assistantFileKindSchema,
  size: z.number().int().positive().max(ASSISTANT_FILE_BYTES), received: z.number().int().nonnegative().max(ASSISTANT_FILE_BYTES),
  status: z.enum(['uploading', 'queued', 'reading', 'ready', 'failed']),
  textChars: z.number().int().nonnegative().max(ASSISTANT_FILE_TEXT).optional(), pages: z.number().int().positive().max(100).optional(),
  ocr: z.boolean().optional(), preview: z.string().max(600).optional(), error: z.string().max(500).optional(),
  /**
   * A page the user shared from the panel: its address as the model reads it, and
   * whether the text was cut. The host keeps it from tasks and limits the turn that
   * reads it to the page's own site. A file without it is an ordinary attachment.
   * `approval` is the image on a web approval card: shown to the user, never read.
   */
  source: z.enum(['page', 'approval']).optional(), pageUrl: z.string().url().max(2048).optional(), pageTruncated: z.literal(true).optional(),
  /** A shared page file that holds only the text the user selected on it. */
  pageSelection: z.literal(true).optional(),
}).strict();
export type AssistantFile = z.infer<typeof assistantFileSchema>;
/** One piece of an approval card's image, as the panel fetches it outside the polled view. */
export const assistantApprovalImageSchema = z.object({
  fileId: uuidSchema, mimeType: z.enum(['image/jpeg', 'image/png']),
  offset: z.number().int().nonnegative(), total: z.number().int().positive().max(Math.ceil(ASSISTANT_APPROVAL_IMAGE_BYTES / 3) * 4),
  base64: z.string().max(ASSISTANT_APPROVAL_IMAGE_CHUNK).regex(/^[A-Za-z0-9+/]*={0,2}$/),
}).strict();
export type AssistantApprovalImage = z.infer<typeof assistantApprovalImageSchema>;
export const assistantFileRequestSchema = z.object({
  action: z.enum(['list', 'read']), fileId: uuidSchema.optional(),
  offset: z.number().int().min(0).max(ASSISTANT_FILE_TEXT).default(0),
  limit: z.number().int().min(1).max(12000).default(8000),
}).strict();
export type AssistantFileRequest = z.infer<typeof assistantFileRequestSchema>;
export function assistantFileKind(name: string): AssistantFileKind | undefined {
  const ext = name.toLowerCase().split('.').at(-1);
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (['png', 'jpg', 'jpeg', 'webp'].includes(ext || '')) return 'image';
  if (['txt', 'md', 'csv', 'tsv', 'json', 'xml', 'html', 'htm', 'log', 'yaml', 'yml'].includes(ext || '')) return 'text';
  return undefined;
}
