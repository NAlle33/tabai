import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { renameSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import type { AssistantSettings } from '../shared/assistant';
import { assistantAgentConfig, type AssistantAccountTest, type AssistantAgentSettings, type AssistantLocalRuntime } from '../shared/assistant-diagnostics';
import { assistantConnectionSchema, type AssistantConnection } from '../shared/assistant-services';
import { assistantLocalModel, verifyAssistantLocalRuntime, type AssistantLocalVerification } from './assistant-local-models';
import { OllamaClient } from './assistant-ollama';
import { atomicPrivateFile, isMissing, privateDirectory, readPrivateFile, withStoreLock } from './private-storage';

type Provider = 'codex' | 'claude' | 'local' | 'berget';
const providers: Provider[] = ['codex', 'claude', 'local', 'berget'];
const labels = { codex: 'Codex', claude: 'Claude', local: 'Lokal modell', berget: 'Berget' };
const recordSchema = assistantConnectionSchema.extend({ id: z.enum(['codex', 'claude', 'local', 'berget']), keyStamp: z.string().optional(), runtimeVersion: z.string().optional(), catalogOnly: z.literal(true).optional(), statusOnly: z.literal(true).optional() });
const storeSchema = z.object({ version: z.literal(1), records: z.array(recordSchema).max(4) }).strict();
type TestRecord = z.infer<typeof recordSchema>;
const modelFor = (provider: Provider, agent?: AssistantAgentSettings) => {
  const config = assistantAgentConfig(agent);
  return provider === 'berget' ? config.berget!.model : config[provider].model;
};
type CliSpawn = (command: string, args: string[], options: SpawnOptionsWithoutStdio & { stdio: 'pipe' }) => ChildProcessWithoutNullStreams;

/** Fixed read-only auth commands; raw CLI output never leaves this function. */
async function verifyCliAuth(provider: 'codex' | 'claude', directory: string, signal: AbortSignal, spawnCli: CliSpawn): Promise<void> {
  const args = provider === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json'];
  const command = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : provider;
  const argv = process.platform === 'win32' ? ['/d', '/s', '/c', provider === 'codex' ? 'codex login status' : 'claude auth status --json'] : args;
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'LOCALAPPDATA', 'APPDATA', 'USER', 'USERNAME', 'LOGNAME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL'])
    if (process.env[name] !== undefined) env[name] = process.env[name];
  await new Promise<void>((resolve, reject) => {
    const child = spawnCli(command, argv, { cwd: directory, env, stdio: 'pipe', shell: false, windowsHide: true, detached: process.platform !== 'win32' });
    let stdout = '', stderr = '', bytes = 0, failed = false, killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (force = false) => {
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
      if (process.platform === 'win32') {
        const reaper = spawn('taskkill', ['/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])], { windowsHide: true, stdio: 'ignore', shell: false });
        reaper.on('error', () => { try { child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch { /* The process may already have exited. */ } });
      } else { try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); } catch { try { child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch { /* Already exited. */ } } }
    };
    const stop = () => { failed = true; kill(); if (!killTimer) { killTimer = setTimeout(() => kill(true), 500); killTimer.unref(); } };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    const receive = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      bytes += chunk.byteLength;
      if (bytes > 32 * 1024) { stop(); return; }
      if (stream === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', chunk => receive(chunk, 'stdout'));
    child.stderr.on('data', chunk => receive(chunk, 'stderr'));
    child.stdin.on('error', stop); child.stdin.end();
    child.on('error', () => { failed = true; });
    child.once('close', code => {
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener('abort', stop);
      let authenticated = false;
      if (!failed && !signal.aborted && code === 0) {
        if (provider === 'codex') authenticated = /(?:^|\n)\s*Logged in using [^\r\n]+(?:\r?\n|$)/i.test(stdout + '\n' + stderr);
        else { try { authenticated = JSON.parse(stdout).loggedIn === true; } catch { /* Unknown output cannot prove authentication. */ } }
      }
      stdout = ''; stderr = '';
      if (authenticated) resolve(); else reject(new Error('CLI-inloggningen kunde inte verifieras.'));
    });
  });
}

/** A public metadata check never needs credentials, inference or a reservation. */
async function verifyBergetCatalog(model: string, signal: AbortSignal): Promise<void> {
  const response = await fetch('https://api.berget.ai/v1/models/', { method: 'GET', redirect: 'error', signal, headers: { Accept: 'application/json' } });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Katalogen är inte tillgänglig.'); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (signal.aborted) throw new Error('Katalogtestet avbröts.');
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw new Error('Katalogen är för stor.');
      chunks.push(next.value);
    }
  } finally { signal.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  if (!Array.isArray(raw?.data) || raw.data.length > 1000) throw new Error('Katalogformatet är ogiltigt.');
  const matching = raw.data.filter((row: unknown) => row && typeof row === 'object' && 'id' in row && row.id === model);
  if (matching.length !== 1) throw new Error('Modellens katalogidentitet är okänd eller tvetydig.');
  const selected = matching[0];
  if (selected.lifecycle_status !== 'active' || selected.lifecycle_state !== 'stable' || selected.end_of_life || selected.status?.up !== true
    || selected.capabilities?.function_calling !== true || selected.capabilities?.streaming !== true
    || selected.pricing?.currency !== 'EUR' || selected.pricing?.unit !== '€ / M Token'
    || !Number.isFinite(selected.pricing?.input) || selected.pricing.input < 0 || !Number.isFinite(selected.pricing?.output) || selected.pricing.output < 0)
    throw new Error('Modellens tillgänglighet, funktioner eller pris kunde inte verifieras.');
}

/** Saved settings, auth state and runtime/catalog metadata remain separate facts. */
export class AssistantConnections {
  private readonly file: string;
  private checking?: { provider: Provider; model: string; abort: AbortController; promise: Promise<void> };
  private closed = false;
  /** `testTimeoutMs` bounds one connection test; only tests shorten it. */
  constructor(_root: string, private dataDir: string, private spawnCli: CliSpawn = spawn, private testTimeoutMs = 15_000) { this.file = join(dataDir, 'assistant-connections.json'); }
  get busy(): boolean { return !!this.checking; }
  private records(): TestRecord[] {
    try { return storeSchema.parse(JSON.parse(readPrivateFile(this.file, 16_000).toString('utf8'))).records; }
    catch (error) { if (isMissing(error)) return []; throw new Error('Anslutningstesterna kan inte läsas säkert. Kör ett nytt test efter att lagringen kontrollerats.'); }
  }
  /**
   * The records under the store lock. The history is only a status cache: an unreadable
   * file is moved aside, intact, and the history starts empty.
   */
  private recoverRecords(): TestRecord[] {
    try { return this.records(); }
    catch (error) {
      try { renameSync(this.file, `${this.file}.${Date.now()}.unreadable`); } catch { throw error; }
      return [];
    }
  }
  view(settings: AssistantSettings, localRuntime: AssistantLocalRuntime, accountTests: AssistantAccountTest[], bergetConfigured: boolean): AssistantConnection[] {
    let records: TestRecord[];
    try { records = this.records(); }
    catch {
      const message = 'Anslutningstesternas privata historik kan inte läsas. Nästa anslutningstest lägger den åt sidan och börjar om; inga tidigare resultat kan bekräftas.';
      return [...providers.map(provider => ({ id: provider, label: labels[provider], state: 'action-required' as const, model: modelFor(provider, settings.agent), configured: provider === 'berget' ? bergetConfigured : provider === 'local' ? localRuntime.models.some(entry => entry.id === modelFor(provider, settings.agent) && entry.state === 'ready') : true, message })),
        ...settings.accounts.map(account => ({ id: `mail:${account.id}`, label: account.label, state: 'action-required' as const, configured: true, message }))];
    }
    const rows: AssistantConnection[] = providers.map((provider): AssistantConnection => {
      const model = modelFor(provider, settings.agent), configured = provider === 'berget' ? bergetConfigured : provider === 'local' ? localRuntime.models.some(entry => entry.id === model && entry.state === 'ready') : true;
      if (this.checking?.provider === provider) return { id: provider, label: labels[provider], state: 'checking' as const, configured, model: this.checking.model, message: provider === 'berget' ? 'Bergets offentliga modellkatalog kontrolleras. Inget modell- eller nyckeltest körs.' : provider === 'local' ? 'Lokal runtime och modellidentitet kontrolleras utan textgenerering.' : 'CLI-inloggningens status kontrolleras utan inferens.' };
      const record = records.find(entry => entry.id === provider && entry.model === model && (entry.statusOnly === true || provider === 'berget' && entry.catalogOnly === true));
      if (provider === 'berget') {
        const saved = configured ? 'Nyckel sparad men dess behörighet är inte testad.' : 'Ingen Berget-nyckel är sparad.';
        return { id: provider, label: labels[provider], model, configured, state: !configured || record?.state === 'action-required' ? 'action-required' : 'unknown',
          ...(record?.testedAt ? { testedAt: record.testedAt } : {}), message: `${record?.message ?? 'Den valda modellens offentliga katalog är ännu inte testad.'} ${saved}` };
      }
      if (!configured) return { id: provider, label: labels[provider], state: 'action-required' as const, configured, model, message: 'Den valda lokala modellen är inte verifierad. Kontrollera lokal runtime i inställningarna.' };
      if (provider === 'local' && record?.state !== 'action-required' && (!localRuntime.reachable || record?.runtimeVersion !== localRuntime.version)) return { id: provider, label: labels[provider], state: 'unknown' as const, configured, model, message: 'Lokal runtime behöver ett nytt anslutningstest.' };
      if (record) { const { keyStamp: _stamp, runtimeVersion: _runtime, catalogOnly: _catalog, statusOnly: _status, ...visible } = record; return { ...visible, configured }; }
      return { id: provider, label: labels[provider], state: 'unknown' as const, configured, model, message: 'Modellval finns. Inloggnings- eller runtimestatus är ännu inte testad. Inferens har inte testats.' };
    });
    for (const account of settings.accounts) {
      const latest = accountTests.filter(test => test.accountId === account.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      rows.push({ id: `mail:${account.id}`, label: account.label, configured: true,
        state: latest?.status === 'running' ? 'checking' : latest?.status === 'passed' ? 'ready' : latest ? 'action-required' : 'unknown',
        message: latest?.status === 'passed' ? 'Kontots identitet och läsytor verifierades i det senaste kontotestet.' : latest?.status === 'running' ? 'Kontots verifierade läsytor testas.' : latest ? 'Kontotestet kräver en åtgärd. Öppna kontoinställningarna.' : 'Konto sparat. Läsåtkomst är ännu inte testad.',
        ...(latest ? { testedAt: latest.updatedAt } : {}) });
    }
    return rows.map(row => assistantConnectionSchema.parse(row));
  }
  async test(provider: Provider, agent: AssistantAgentSettings | undefined, verifications: AssistantLocalVerification[]): Promise<void> {
    if (this.closed) throw new Error('Anslutningstesterna har stängts.');
    if (this.checking) throw new Error('Ett anslutningstest pågår redan.');
    if (!providers.includes(provider)) throw new Error('Okänd anslutning.');
    const model = modelFor(provider, agent), abort = new AbortController();
    let resolveDone!: () => void;
    const promise = new Promise<void>(resolve => { resolveDone = resolve; });
    this.checking = { provider, model, abort, promise };
    let timedOut = false, failure: string | undefined, runtimeVersion: string | undefined;
    const timer = setTimeout(() => { timedOut = true; abort.abort(); }, this.testTimeoutMs); timer.unref();
    try {
      privateDirectory(this.dataDir);
      if (provider === 'berget') await verifyBergetCatalog(model, abort.signal);
      else if (provider === 'local') {
        const client = new OllamaClient();
        runtimeVersion = await client.version(abort.signal);
        const [tags, show] = await Promise.all([client.tags(abort.signal), client.show(model, abort.signal)]);
        verifyAssistantLocalRuntime(assistantLocalModel(model), runtimeVersion, tags, show, verifications);
      } else await verifyCliAuth(provider, this.dataDir, abort.signal, this.spawnCli);
      if (abort.signal.aborted || this.closed) throw new Error('Anslutningstestet avbröts.');
    } catch {
      failure = this.closed ? 'Anslutningstestet avbröts.' : timedOut ? 'Anslutningstestet nådde tidsgränsen och stoppades.'
        : provider === 'berget' ? 'Den valda modellen kunde inte verifieras i Bergets offentliga katalog. Kontrollera modellval och katalogens tillgänglighet.'
        : provider === 'local' ? 'Lokal runtime, modellidentitet eller befintlig verifiering kunde inte bekräftas. Kontrollera lokal runtime och modellens separata självtest.'
        : 'CLI-inloggningen kunde inte verifieras. Kontrollera installation och inloggning.';
    } finally {
      clearTimeout(timer);
      try {
        privateDirectory(this.dataDir);
        const success = provider === 'berget' ? 'Bergets offentliga modellkatalog verifierades för vald aktiv modell, verktygs- och streamingstöd samt aktuellt EUR-pris.'
          : provider === 'local' ? 'Lokal runtime, modellens digest och befintlig verifiering har bekräftats.' : `${labels[provider]}: CLI-inloggning har verifierats.`;
        const untested = provider === 'berget' ? 'Nyckelbehörighet och inferens har inte testats.' : 'Vald modells inferensförmåga har inte testats.';
        const record: TestRecord = { id: provider, label: labels[provider], model, configured: provider !== 'berget', state: failure ? 'action-required' : provider === 'berget' ? 'unknown' : 'ready', testedAt: new Date().toISOString(), message: `${failure ?? success} ${untested}`, statusOnly: true,
          ...(provider === 'berget' ? { catalogOnly: true as const } : {}), ...(provider === 'local' ? { runtimeVersion } : {}) };
        await withStoreLock(this.file, () => { const records = this.recoverRecords().filter(entry => entry.id !== provider); records.push(record); atomicPrivateFile(this.file, JSON.stringify({ version: 1, records })); });
      } finally { this.checking = undefined; resolveDone(); }
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    const checking = this.checking;
    if (!checking) return;
    checking.abort.abort();
    await checking.promise;
  }
}
