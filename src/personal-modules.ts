import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import * as z from "zod";
import { readPrivateFile, isMissing } from "./private-storage";
import { moduleIdSchema, moduleViewSchema, type ModuleOperation, type ModuleView, type PersonalModule } from "../shared/personal-modules";
import { assistantNoticeSchema, type AssistantNotice } from "../shared/assistant-notice";
import { assistantModuleRequestSchema, type AssistantModuleRequest } from '../shared/assistant-services';

const FRAME_LIMIT = 2 * 1024 * 1024;
const registrationSchema = z.object({
  id: moduleIdSchema, command: z.string().refine(isAbsolute),
  args: z.array(z.string().max(4000)).max(30), cwd: z.string().refine(isAbsolute),
}).strict();
const registrySchema = z.array(registrationSchema).max(10).refine(items => new Set(items.map(item => item.id)).size === items.length);
type Registration = z.infer<typeof registrationSchema>;
type Pending = { resolve: (view: ModuleView) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

class ModuleProcess {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, Pending>();
  private buffer = "";
  private failed = false;
  private exited: Promise<void> = Promise.resolve();
  private services = new Set<string>();
  constructor(private registration: Registration, private configDir: string, private notice?: (notice: AssistantNotice) => void, private service?: (command: AssistantModuleRequest) => Promise<unknown>) {}

  private start() {
    if (this.child) return;
    if (this.failed) throw new Error("Modulen stoppades. Starta om Tabais broker och kontrollera ärendets status.");
    // Only an explicitly installed local registry may choose an executable.
    // Panel data is sent through stdin, never inserted into a shell command.
    const env: NodeJS.ProcessEnv = {};
    // USER and LOGNAME: the Claude CLI finds its login in the macOS keychain by user name.
    for (const key of ["PATH", "HOME", "USER", "LOGNAME", "USERPROFILE", "SYSTEMROOT", "TMPDIR", "TEMP", "LANG", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "CCMCP_PORT", "CCMCP_CLIENT_PORT", "CCMCP_CONFIG_DIR", "CCMCP_LOG_DIR", "BRIDGE_TOKEN"]) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    // A module's browser client may use a separate recipe store. If it respawns
    // the broker, retain the registry that launched this module.
    env.CCMCP_MODULE_CONFIG_DIR = this.configDir;
    this.child = spawn(this.registration.command, this.registration.args, {
      cwd: this.registration.cwd, env, shell: false, stdio: "pipe", windowsHide: true,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > FRAME_LIMIT) { this.fail(); return; }
      let newline;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
        try {
          const frame = JSON.parse(line);
          if (frame.type === 'assistant-service') {
            if (this.registration.id !== 'daily-assistant' || !this.service || typeof frame.id !== 'string' || frame.id.length > 100) { this.fail(); return; }
            if (this.services.has(frame.id)) continue;
            this.services.add(frame.id);
            if (this.services.size > 1000) this.services.delete(this.services.values().next().value!);
            const child = this.child;
            void (async () => {
              let response: unknown;
              try {
                const result = await this.service!(assistantModuleRequestSchema.parse(frame.command));
                response = { type: 'assistant-service-response', id: frame.id, ok: true, result };
                if (Buffer.byteLength(JSON.stringify(response)) > FRAME_LIMIT) throw new Error('Module response too large');
              } catch { response = { type: 'assistant-service-response', id: frame.id, ok: false, error: 'Modulfunktionen kunde inte slutföras. Kontrollera dess status; åtgärden upprepas inte automatiskt.' }; }
              if (!this.failed && this.child === child) child?.stdin.write(JSON.stringify(response) + '\n');
            })();
            continue;
          }
          if (frame.type === "assistant-notice" && this.registration.id === "daily-assistant") {
            const parsed = assistantNoticeSchema.safeParse(frame.notice);
            if (parsed.success) this.notice?.(parsed.data);
            continue;
          }
          const pending = this.pending.get(frame.id);
          if (!pending) continue;
          this.pending.delete(frame.id); clearTimeout(pending.timer);
          if (frame.ok !== true) pending.reject(new Error(typeof frame.error === "string" && frame.error.length <= 1000 ? frame.error : "Modulen kunde inte utföra åtgärden. Kontrollera status innan du försöker igen."));
          else {
            const result = moduleViewSchema.safeParse(frame.result);
            if (!result.success) pending.reject(new Error("Modulen returnerade ett ogiltigt svar."));
            else pending.resolve(result.data);
          }
        } catch { this.fail(); return; }
      }
    });
    // Module output can contain private records. Do not forward it to shared logs.
    this.child.stderr.resume();
    this.child.stdin.on("error", () => this.fail());
    this.child.on("error", () => this.fail());
    this.child.on("exit", () => this.fail());
  }

  private fail() {
    this.failed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Den lokala modulen avslutades. Sparat arbete kan redan finnas; kontrollera status efter omstart."));
    }
    this.pending.clear();
    this.close();
  }

  request(operation: ModuleOperation, input: Record<string, string>): Promise<ModuleView> {
    this.start();
    if (this.failed) return Promise.reject(new Error("Modulen är frånkopplad. Starta om Tabais broker."));
    if (this.pending.size >= 8) return Promise.reject(new Error("Modulen arbetar. Vänta ett ögonblick."));
    const id = randomUUID(), frame = JSON.stringify({ id, operation, input }) + "\n";
    if (Buffer.byteLength(frame) > FRAME_LIMIT) return Promise.reject(new Error("Modulens indata är för stor."));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Modulen svarade inte i tid. Kontrollera status; starten kan redan ha utförts."));
      }, 7000);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(frame);
    });
  }

  /** Resolves once the process has exited (it is killed after 3 s), also when
   *  an earlier failure already began stopping it. */
  close(): Promise<void> {
    this.failed = true;
    const child = this.child;
    this.child = undefined;
    // No pid: the spawn itself failed and no process exists to wait for.
    if (child && child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      this.exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
      child.stdin.end();
      child.kill("SIGTERM");
      const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 3000);
      timer.unref();
    }
    return this.exited;
  }
}

/** Trusted, opt-in local modules. Nothing is installed or discovered from pages. */
export class PersonalModules {
  private registrations?: Registration[];
  private processes = new Map<string, ModuleProcess>();
  private closed = false;
  constructor(private configDir: string, private builtins: Registration[] = [], private notice?: (notice: AssistantNotice) => void) {}

  private load(): Registration[] {
    if (this.registrations) return this.registrations;
    let bytes: Buffer;
    try { bytes = readPrivateFile(join(this.configDir, "personal-modules.json"), 64000); }
    catch (error) { if (isMissing(error)) return this.registrations = [...this.builtins]; throw new Error("Kan inte läsa lokala moduler. Kontrollera registreringsfilen."); }
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Ogiltig lokal modulregistrering. Ingen modul startades."); }
    const result = registrySchema.safeParse(parsed);
    if (!result.success) throw new Error("Ogiltig lokal modulregistrering. Ingen modul startades.");
    if (result.data.some(item => this.builtins.some(builtin => builtin.id === item.id))) throw new Error("En lokal modul använder ett reserverat modulnamn.");
    return this.registrations = [...this.builtins, ...result.data];
  }

  async list(): Promise<PersonalModule[]> {
    let registrations: Registration[], registryError = false;
    try { registrations = this.load(); } catch (error) {
      if (!this.builtins.length) throw error;
      registrations = this.builtins; registryError = true;
    }
    const modules: PersonalModule[] = await Promise.all(registrations.map(async registration => {
      try { return { id: registration.id, view: await this.request(registration.id, "status", {}) }; }
      catch { return { id: registration.id, error: "Kunde inte läsa den lokala modulen. Kontrollera installationen och starta om Tabais broker." }; }
    }));
    if (registryError) modules.push({ id: "personal-module-registry", error: "Lokala modulers registreringsfil kunde inte läsas. Vardagsassistenten är fortfarande tillgänglig; kontrollera den privata modulregistreringen." });
    return modules;
  }

  request(id: string, operation: ModuleOperation, input: Record<string, string>): Promise<ModuleView> {
    if (this.closed) throw new Error("Lokala moduler stängs av.");
    const registration = this.builtins.find(item => item.id === id) ?? this.load().find(item => item.id === id);
    if (!registration) throw new Error("Den lokala modulen är inte installerad.");
    let process = this.processes.get(id);
    if (!process) { process = new ModuleProcess(registration, this.configDir, this.notice, id === 'daily-assistant' && this.builtins.includes(registration) ? command => this.assistantService(command) : undefined); this.processes.set(id, process); }
    return process.request(operation, input);
  }

  private async assistantService(command: AssistantModuleRequest): Promise<unknown> {
    const registrations = this.load().filter(item => item.id !== 'daily-assistant');
    if (command.action === 'list') return Promise.all(registrations.map(async registration => {
      try {
        const view = await this.request(registration.id, 'status', {});
        return { id: registration.id, title: view.title, description: view.description, fields: view.fields.map(({ name, label, required, multiline }) => ({ name, label, required, multiline })) };
      } catch { return { id: registration.id, title: registration.id, description: 'Modulen är inte tillgänglig.', fields: [], unavailable: true }; }
    }));
    if (!registrations.some(item => item.id === command.moduleId)) throw new Error('Modulen är inte installerad.');
    const { operation, input, moduleId } = command;
    const view = await this.request(moduleId, 'status', {});
    const permitted = operation === 'start' ? view.fields.map(field => field.name)
      : operation === 'reply' ? ['run-id', 'question-id', 'answer', 'message-id']
      : operation === 'message' ? ['run-id', 'message-id', 'message']
      : operation === 'stop' ? ['run-id']
      : operation === 'select' ? ['case-id'] : operation === 'history' ? ['query', 'archived', 'offset'] : [];
    if (Object.keys(input).length > 20 || Object.keys(input).some(key => !permitted.includes(key))) throw new Error('Otillåten modulparameter.');
    if (['reply', 'message', 'stop'].includes(operation) && (!view.run || input['run-id'] !== view.run.id)) throw new Error('Modulkörningen har ändrats.');
    if (operation === 'message' && view.run?.messaging !== 'ready') throw new Error('Ärendet tar inte emot meddelanden just nu.');
    if (operation === 'reply' && (!view.run?.questionId || view.run.questionId !== input['question-id'])) throw new Error('Modulfrågan har ändrats.');
    return operation === 'status' ? view : this.request(moduleId, operation, input);
  }

  /** Resolves once every module process has exited. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.processes.values()].map(process => process.close()));
  }
}
