import * as z from 'zod';
import { dateTimeSchema, uuidSchema } from './stable-schemas';
import { assistantBergetDefaults, assistantBergetSettingsSchema } from './assistant-berget';

export const assistantTestStepKeySchema = z.enum(['identity', 'inbox', 'thread', 'sent']);
export const assistantAccountTestStepSchema = z.object({
  key: assistantTestStepKeySchema,
  status: z.enum(['pending', 'running', 'passed', 'failed', 'skipped']),
  message: z.string().max(2000), code: z.string().max(100).optional(),
}).strict();
export const assistantAccountTestSchema = z.object({
  id: uuidSchema, accountId: z.string().max(60),
  startedAt: dateTimeSchema, updatedAt: dateTimeSchema,
  status: z.enum(['running', 'passed', 'partial', 'failed', 'interrupted']),
  steps: z.array(assistantAccountTestStepSchema).length(4), tabId: z.number().int().positive().optional(),
}).strict();
export type AssistantAccountTest = z.infer<typeof assistantAccountTestSchema>;
export type AssistantAccountTestStep = z.infer<typeof assistantAccountTestStepSchema>;
export const assistantCodexSettingsSchema = z.object({
  model: z.enum(['gpt-6.1-terra', 'gpt-6.1-sol']),
  reasoningEffort: z.enum(['medium', 'high']),
}).strict();
export type AssistantCodexSettings = z.infer<typeof assistantCodexSettingsSchema>;
/** Claude runs through the Claude Code CLI with the user's own login; Tabai stores no API key. */
export const assistantClaudeModelIds = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1'] as const;
export const assistantClaudeSettingsSchema = z.object({
  model: z.enum(assistantClaudeModelIds),
  effort: z.enum(['medium', 'high']),
}).strict();
export type AssistantClaudeSettings = z.infer<typeof assistantClaudeSettingsSchema>;
export const assistantClaudeModelInfo: Record<AssistantClaudeSettings['model'], { label: string; role: string }> = {
  'claude-opus-5-5': { label: 'Claude Opus 5.5', role: 'rekommenderad' },
  'claude-sonnet-5-5': { label: 'Claude Sonnet 5.5', role: 'snabbare' },
  'claude-fable-5-1': { label: 'Claude Fable 5.1', role: 'mest kapabel, högst kostnad' },
};
/** Exact pinned local model tags; the host catalog adds digests and profiles. */
export const assistantLocalModelIds = ['qwen3.5:4b-q4_K_M'] as const;
export const assistantLocalModelIdSchema = z.enum(assistantLocalModelIds);
/** Migrate saved choices only; runtime operations and self-tests still name the exact model. */
export const assistantStoredLocalModelIdSchema = z.preprocess(value =>
  value === 'qwen3.5:2b-q4_K_M' || value === 'qwen3.5:9b-q4_K_M' ? assistantLocalModelIds[0] : value,
assistantLocalModelIdSchema);
export type AssistantLocalModelId = z.infer<typeof assistantLocalModelIdSchema>;
/** Display and licence facts shown before a user pulls a model; weights are never bundled. */
export const assistantLocalModelInfo: Record<AssistantLocalModelId, { label: string; role: string; size: string; license: { name: string; url: string; note?: string }; notice?: string }> = {
  'qwen3.5:4b-q4_K_M': { label: 'Qwen3.5 4B', role: 'Rekommenderad lokal modell', size: 'ca 3,3 GB', license: { name: 'Apache-2.0', url: 'https://huggingface.co/Qwen/Qwen3.5-4B/blob/main/LICENSE' } },
};
export const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download';
/**
 * Stored settings keep the earlier Codex-only shape readable as-is: strict
 * workspace parsing must never lock out an existing installation. Both
 * backends' choices are kept, so switching back loses nothing.
 */
export const assistantAgentSettingsSchema = z.union([
  z.object({
    backend: z.enum(['codex', 'claude', 'local', 'berget']),
    codex: assistantCodexSettingsSchema,
    // Optional: settings saved before the Claude backend existed have no Claude choice.
    claude: assistantClaudeSettingsSchema.optional(),
    berget: assistantBergetSettingsSchema.optional(),
    local: z.object({ model: assistantStoredLocalModelIdSchema }).strict(),
  }).strict(),
  assistantCodexSettingsSchema,
]);
export type AssistantAgentSettings = z.infer<typeof assistantAgentSettingsSchema>;
export interface AssistantAgentConfig { backend: 'codex' | 'claude' | 'local' | 'berget'; codex: AssistantCodexSettings; claude: AssistantClaudeSettings; local: { model: AssistantLocalModelId }; berget?: z.infer<typeof assistantBergetSettingsSchema> }
export const assistantCodexDefaults: AssistantCodexSettings = { model: 'gpt-6.1-terra', reasoningEffort: 'medium' };
export const assistantClaudeDefaults: AssistantClaudeSettings = { model: 'claude-opus-5-5', effort: 'medium' };
export const assistantAgentDefaults: AssistantAgentConfig = { backend: 'codex', codex: { ...assistantCodexDefaults }, claude: { ...assistantClaudeDefaults }, local: { model: 'qwen3.5:4b-q4_K_M' }, berget: { ...assistantBergetDefaults } };
/** Absent and legacy settings mean the explicit Codex choice that existed before local inference. */
export function assistantAgentConfig(agent?: AssistantAgentSettings): AssistantAgentConfig {
  if (!agent) return structuredClone(assistantAgentDefaults);
  if ('backend' in agent) return { ...structuredClone(agent), claude: { ...(agent.claude ?? assistantClaudeDefaults) }, berget: { ...(agent.berget ?? assistantBergetDefaults) } };
  return { backend: 'codex', codex: { model: agent.model, reasoningEffort: agent.reasoningEffort }, claude: { ...assistantClaudeDefaults }, local: { ...assistantAgentDefaults.local }, berget: { ...assistantBergetDefaults } };
}

/** Keep unused defaults out of persisted settings so older choices stay readable. */
export function assistantAgentForStorage(agent: AssistantAgentSettings): AssistantAgentSettings {
  const config = structuredClone(agent);
  if (!('backend' in config)) return config;
  if (config.backend !== 'claude' && JSON.stringify(config.claude) === JSON.stringify(assistantClaudeDefaults)) delete config.claude;
  if (config.backend !== 'berget' && JSON.stringify(config.berget) === JSON.stringify(assistantBergetDefaults)) delete config.berget;
  if (config.backend === 'codex' && config.local.model === assistantAgentDefaults.local.model
    && (!config.claude || JSON.stringify(config.claude) === JSON.stringify(assistantClaudeDefaults)) && !config.berget) return { ...config.codex };
  return config;
}

/** Transient host-side runtime state for the panel; never stored in settings or the workspace. */
export const assistantLocalModelStatusSchema = z.object({
  id: assistantLocalModelIdSchema,
  state: z.enum(['unknown', 'missing', 'ready', 'mismatch', 'untested']),
  loaded: z.boolean(), vramBytes: z.number().int().nonnegative().optional(),
  message: z.string().max(500).optional(), verifiedAt: dateTimeSchema.optional(),
}).strict();
export const assistantLocalOperationSchema = z.object({
  id: uuidSchema, kind: z.enum(['pull', 'selftest', 'unload']), model: assistantLocalModelIdSchema,
  status: z.enum(['running', 'aborting', 'done', 'failed', 'aborted']), message: z.string().max(500),
  completed: z.number().int().nonnegative().optional(), total: z.number().int().nonnegative().optional(),
  startedAt: dateTimeSchema, updatedAt: dateTimeSchema,
}).strict();
export const assistantLocalRuntimeSchema = z.object({
  reachable: z.boolean(), checking: z.boolean(), version: z.string().max(60).optional(),
  message: z.string().max(500).optional(), checkedAt: dateTimeSchema.optional(),
  models: z.array(assistantLocalModelStatusSchema).max(assistantLocalModelIds.length),
  operation: assistantLocalOperationSchema.optional(),
}).strict();
export type AssistantLocalRuntime = z.infer<typeof assistantLocalRuntimeSchema>;
export type AssistantLocalOperation = z.infer<typeof assistantLocalOperationSchema>;
