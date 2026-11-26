import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as z from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { assistantBergetModelSchema } from '../shared/assistant-berget';
import { AssistantBudget } from './assistant-budget';
import { BergetClient, BergetError, AssistantBergetKey } from './assistant-berget';
import { runBergetAgent, type BergetWorker } from './assistant-berget-agent';
import { assistantWorkerLink, assistantWorkerMode, assistantToolTimeout, type AssistantWorkerMode } from './assistant-tools';
import type { AssistantProviderProgress } from './assistant-provider-progress';

const configSchema = z.object({
  model: assistantBergetModelSchema,
  deadlineAt: z.number().int().positive(),
  dataDir: z.string().min(1).max(4000),
  runId: z.string().min(1).max(100),
}).strict();

/**
 * One paid run. Only a chat turn streams, for its reply preview; Berget documents no usage
 * on a stream, so a streamed turn keeps its whole reservation. Tasks, routines and watches
 * show no preview: they call without streaming, and the usage Berget reports settles each
 * reservation.
 */
export async function runBergetRunner(options: {
  key: string; fetcher: typeof fetch; config: z.infer<typeof configSchema>; mode: AssistantWorkerMode; prompt: string;
  worker: BergetWorker; signal: AbortSignal; progress(event: AssistantProviderProgress): void;
}): Promise<void> {
  const { config, mode } = options;
  await runBergetAgent({ client: new BergetClient(options.key, options.fetcher, { budget: new AssistantBudget(config.dataDir), runId: config.runId }), worker: options.worker,
    model: config.model, prompt: options.prompt, signal: options.signal, deadlineAt: config.deadlineAt,
    // A routine's turn is a chat turn with fewer tools; the worker lists exactly those.
    chat: mode === true || mode === 'routine', watch: mode === 'watch', stream: mode === true, progress: options.progress });
}

/** The line the host reads when a run fails: the code tells whether Berget could not run or the run itself failed. */
export function bergetRunnerStatus(error: unknown): { type: 'berget-status'; message: string; code?: BergetError['code'] } {
  return error instanceof BergetError ? { type: 'berget-status', message: error.message, code: error.code }
    : { type: 'berget-status', message: 'Berget-agenten avbröts. Inga anrop upprepades automatiskt.' };
}

async function main(): Promise<void> {
  const abort = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => abort.abort());
  const config = configSchema.parse(JSON.parse(process.env.TABAI_BERGET_CONFIG ?? '{}'));
  const mode = assistantWorkerMode(process.env.TABAI_ASSISTANT_CHAT);
  const key = new AssistantBergetKey(config.dataDir).read();
  const client = new Client({ name: 'tabai-berget-runner', version: '1.0.0' });
  try {
    if (!key) throw new BergetError('key', 'Anslut Berget i inställningarna först.');
    process.stdin.setEncoding('utf8');
    let prompt = '';
    for await (const chunk of process.stdin) {
      prompt += chunk;
      if (Buffer.byteLength(prompt) > 256 * 1024) throw new BergetError('context', 'Uppdragsprompten är för stor.');
    }
    if (!prompt.trim()) throw new BergetError('protocol', 'Uppdragsprompten saknas.');

    const env: Record<string, string> = {};
    const inheritedVariables = ['TABAI_ASSISTANT_SOCKET', 'TABAI_ASSISTANT_SECRET', 'TABAI_ASSISTANT_CHAT', 'TABAI_ASSISTANT_WEB', 'TABAI_ASSISTANT_FULL_ACCESS', 'PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL'];
    for (const name of inheritedVariables) {
      if (process.env[name]) env[name] = process.env[name];
    }
    await client.connect(new StdioClientTransport(assistantWorkerLink(join(dirname(fileURLToPath(import.meta.url)), 'assistant-worker.mjs'), env)));
    await runBergetRunner({ key, fetcher: fetch, config, mode, prompt, signal: abort.signal, worker: {
      listTools: () => client.listTools(),
      callTool: async request => {
        const result = await client.callTool(request, undefined, { signal: abort.signal, timeout: assistantToolTimeout(request.name) });
        if (!Array.isArray(result.content)) throw new BergetError('protocol', 'Assistentens verktyg gav ett okänt svar.');
        return { isError: result.isError === true, content: result.content.flatMap(block => block.type === 'text' ? [{ type: 'text', text: String(block.text) }] : block.type === 'image' ? [{ type: 'text', text: '[Verktyget returnerade en bild. Den här modellanslutningen läser text; använd read_page eller get_page_text för sidans innehåll.]' }] : []) };
      },
    }, progress: event => { if (!abort.signal.aborted) process.stdout.write(JSON.stringify({ type: 'provider-progress', ...event }) + '\n'); } });
  } catch (error) {
    process.stdout.write(JSON.stringify(bergetRunnerStatus(error)) + '\n');
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

// The host starts this file with its configuration; importing it runs nothing.
if (process.env.TABAI_BERGET_CONFIG) await main();
