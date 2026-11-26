import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import * as z from 'zod';
import { dateTimeSchema, uuidSchema } from '../shared/stable-schemas';
import { RecipeStore } from './recipe-store';
import { assistantChatContextSchema, assistantChatMessageSchema, assistantChatModuleTargetSchema, type AssistantChatContext } from '../shared/assistant-chat';
import { assistantMemorySchema, type AssistantMemory } from '../shared/assistant-services';

const legacySchema = z.object({ version: z.literal(1), id: uuidSchema, messages: z.array(assistantChatMessageSchema).max(100) }).strict();
const conversationSchema = z.object({
  id: uuidSchema, title: z.string().trim().min(1).max(120), createdAt: dateTimeSchema, updatedAt: dateTimeSchema,
  context: assistantChatContextSchema.optional(), moduleTarget: assistantChatModuleTargetSchema.optional(), messages: z.array(assistantChatMessageSchema).max(100),
}).strict();
const stateSchema = z.object({
  version: z.literal(2), selected: uuidSchema, conversations: z.array(conversationSchema).min(1).max(100),
  memories: z.array(assistantMemorySchema).max(100), scheduleConversationId: uuidSchema.optional(),
  /** "Bevakningar": created when the first watch result arrives, never selected by it. */
  watchConversationId: uuidSchema.optional(),
  /** "Rutiner": created when the first routine runs, never selected by it. */
  routineConversationId: uuidSchema.optional(),
}).strict().superRefine((state, context) => {
  const ids = new Set(state.conversations.map(conversation => conversation.id));
  if (ids.size !== state.conversations.length || !ids.has(state.selected)) context.addIssue({ code: 'custom', message: 'Invalid conversation selection' });
});
type State = z.infer<typeof stateSchema>;
export type AssistantConversation = z.infer<typeof conversationSchema>;
/** The most one stored conversation may hold; a change past it is refused. */
export const ASSISTANT_CONVERSATION_BYTES = 400_000;
export const assistantConversationBytes = (conversation: AssistantConversation): number => Buffer.byteLength(JSON.stringify(conversation));
const stamp = () => new Date().toISOString();
const fresh = (title = 'Nytt samtal', context?: AssistantChatContext): AssistantConversation => {
  const now = stamp();
  return { id: randomUUID(), title, createdAt: now, updatedAt: now, messages: [], ...(context ? { context } : {}) };
};
function initial(): State {
  const conversation = fresh();
  return { version: 2, selected: conversation.id, conversations: [conversation], memories: [] };
}
export function validateAssistantMemory(value: Pick<AssistantMemory, 'label' | 'value' | 'scope' | 'moduleId'>): void {
  if (/password|lösenord|api.?nyckel|api.?key|access.?token|secret|credential|privat.?nyckel/i.test(value.label)
    || /(?:sk-[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9_.-]{16,})/i.test(value.value))
    throw new Error('Hemligheter ska sparas i anslutningsinställningarna, inte som minne.');
  if (value.scope === 'module' && !value.moduleId) throw new Error('Välj vilken installerad funktion uppgiften gäller.');
}

/** One private backed-up store; only the selected bounded conversation reaches the panel. */
export class AssistantConversations {
  readonly store: RecipeStore<z.infer<typeof legacySchema> | State>;
  private state: State;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly startup: Promise<void>;
  unavailable?: string;
  query = '';

  constructor(dataDir: string) {
    this.store = new RecipeStore(join(dataDir, 'chat.json'), value => z.union([legacySchema, stateSchema]).parse(value));
    let interrupted = false;
    try {
      const loaded = this.store.load().chat;
      if (!loaded) this.state = initial();
      else if (loaded.version === 1) {
        const now = stamp();
        this.state = { version: 2, selected: loaded.id, memories: [], conversations: [{ id: loaded.id, title: loaded.messages.find(message => message.role === 'user')?.text.slice(0, 80) || 'Tidigare samtal', createdAt: loaded.messages[0]?.createdAt || now, updatedAt: loaded.messages.at(-1)?.createdAt || now, messages: loaded.messages }] };
      } else this.state = loaded;
      for (const conversation of this.state.conversations) for (const message of conversation.messages) {
        if (message.status === 'pending') {
          message.status = 'interrupted';
          message.text = 'Svaret avbröts vid omstart. Ingen automatisk fortsättning gjordes.';
          interrupted = true;
        }
        if (message.card?.status === 'applying') {
          message.card.status = 'uncertain';
          message.card.error = 'Åtgärden avbröts. Kontrollera dess verkliga status; den körs inte igen automatiskt.';
          interrupted = true;
        }
      }
    } catch {
      this.state = initial(); this.unavailable = 'Samtalsfilen kunde inte läsas och har bevarats. Övriga funktioner påverkas inte.';
    }
    this.startup = interrupted ? this.store.save('chat', this.state).catch(() => { this.unavailable = 'Avbrottsstatusen kunde inte sparas.'; }) : Promise.resolve();
  }
  ready(): Promise<void> { return this.startup; }
  get selected(): AssistantConversation { return this.state.conversations.find(conversation => conversation.id === this.state.selected)!; }
  get memories(): AssistantMemory[] { return structuredClone(this.state.memories); }
  get conversations(): readonly AssistantConversation[] { return this.state.conversations; }
  get scheduleConversationId(): string | undefined { return this.state.scheduleConversationId; }
  get watchConversationId(): string | undefined { return this.state.watchConversationId; }
  get routineConversationId(): string | undefined { return this.state.routineConversationId; }
  find(id: string): AssistantConversation | undefined { return this.state.conversations.find(conversation => conversation.id === id); }
  hasMessage(id: string): boolean { return this.state.conversations.some(conversation => conversation.messages.some(message => message.id === id)); }

  async change(update: (next: State) => void, purgeBackup = false): Promise<void> {
    await this.startup;
    const run = this.queue.then(async () => {
      if (this.unavailable) throw new Error(this.unavailable);
      const next = structuredClone(this.state);
      update(next);
      stateSchema.parse(next);
      for (const conversation of next.conversations) if (assistantConversationBytes(conversation) > ASSISTANT_CONVERSATION_BYTES) throw new Error('Samtalet är fullt. Börja ett nytt samtal innan du fortsätter.');
      if (Buffer.byteLength(JSON.stringify({ chat: next }, null, 2)) > 7 * 1024 * 1024) throw new Error('Samtalsarkivet är fullt. Radera ett äldre samtal för att fortsätta.');
      await this.store.save('chat', next);
      if (purgeBackup) await this.store.save('chat', next);
      this.state = next;
    });
    this.queue = run.catch(() => {});
    return run;
  }
  async edit(id: string, update: (conversation: AssistantConversation, state: State) => void): Promise<void> {
    await this.change(state => {
      const conversation = state.conversations.find(entry => entry.id === id);
      if (!conversation) throw new Error('Samtalet finns inte längre.');
      update(conversation, state);
      conversation.updatedAt = stamp();
    });
  }
  async create(title = 'Nytt samtal', context?: AssistantChatContext): Promise<string> {
    const conversation = fresh(z.string().trim().min(1).max(120).parse(title), context);
    await this.change(state => {
      state.conversations.push(conversation);
      state.selected = conversation.id;
    });
    return conversation.id;
  }
  async select(id: string): Promise<void> {
    uuidSchema.parse(id);
    await this.change(state => { if (!state.conversations.some(conversation => conversation.id === id)) throw new Error('Samtalet finns inte längre.'); state.selected = id; });
  }
  async rename(id: string, title: string): Promise<void> {
    const parsed = z.string().trim().min(1).max(120).parse(title);
    await this.edit(id, conversation => { conversation.title = parsed; });
  }
  async clear(id: string): Promise<void> {
    await this.change(state => {
      const conversation = state.conversations.find(entry => entry.id === id);
      if (!conversation) throw new Error('Samtalet finns inte längre.');
      conversation.messages = []; conversation.updatedAt = stamp();
    }, true);
  }
  async remove(id: string, replace = false): Promise<void> {
    await this.change(state => {
      if (!state.conversations.some(conversation => conversation.id === id)) throw new Error('Samtalet finns inte längre.');
      state.conversations = state.conversations.filter(conversation => conversation.id !== id);
      if (!state.conversations.length || replace) {
        const conversation = fresh();
        state.conversations.push(conversation);
        state.selected = conversation.id;
      }
      else if (state.selected === id) state.selected = state.conversations.at(-1)!.id;
      if (state.scheduleConversationId === id) delete state.scheduleConversationId;
      if (state.watchConversationId === id) delete state.watchConversationId;
      if (state.routineConversationId === id) delete state.routineConversationId;
    }, true);
  }
  async saveMemory(input: { id?: string; label: string; value: string; scope: AssistantMemory['scope']; moduleId?: string }): Promise<void> {
    validateAssistantMemory(input);
    const memory = assistantMemorySchema.parse({ ...input, id: input.id || randomUUID(), updatedAt: stamp() });
    await this.change(state => {
      const index = input.id ? state.memories.findIndex(entry => entry.id === input.id) : state.memories.findIndex(entry => entry.label.toLocaleLowerCase('sv-SE') === memory.label.toLocaleLowerCase('sv-SE') && entry.scope === memory.scope && entry.moduleId === memory.moduleId);
      if (input.id && index < 0) throw new Error('Minnet finns inte längre.');
      if (index < 0) state.memories.push(memory); else state.memories[index] = { ...memory, id: state.memories[index].id };
    });
  }
  async deleteMemory(id: string): Promise<void> {
    uuidSchema.parse(id);
    await this.change(state => { if (!state.memories.some(memory => memory.id === id)) throw new Error('Minnet finns inte längre.'); state.memories = state.memories.filter(memory => memory.id !== id); }, true);
  }
  async scheduleFor(id: string): Promise<void> { await this.edit(id, (_conversation, state) => { state.scheduleConversationId = id; }); }
  /**
   * One system message in "Bevakningar", which is created on demand and never
   * selected by a background run. It is a log: the oldest entries give way
   * before the conversation's message limit.
   */
  async postWatch(message: AssistantConversation['messages'][number]): Promise<string> {
    return this.postLog('watchConversationId', 'Bevakningar', 'Samtalsarkivet är fullt. Radera ett äldre samtal så att bevakningarna kan rapportera.', message);
  }
  /** One message in "Rutiner", kept the same way as "Bevakningar". */
  async postRoutine(message: AssistantConversation['messages'][number]): Promise<string> {
    return this.postLog('routineConversationId', 'Rutiner', 'Samtalsarkivet är fullt. Radera ett äldre samtal så att rutinerna kan rapportera.', message);
  }
  private async postLog(key: 'watchConversationId' | 'routineConversationId', title: string, full: string, message: AssistantConversation['messages'][number]): Promise<string> {
    let id = '';
    await this.change(state => {
      let conversation = state.conversations.find(entry => entry.id === state[key]);
      if (!conversation) {
        if (state.conversations.length >= 100) throw new Error(full);
        conversation = fresh(title);
        state.conversations.push(conversation);
        state[key] = conversation.id;
      }
      const pending = conversation.messages.filter(entry => entry.status === 'pending').length;
      while (conversation.messages.length >= 90 && conversation.messages.length > pending) {
        const index = conversation.messages.findIndex(entry => entry.status !== 'pending');
        conversation.messages.splice(index, 1);
      }
      conversation.messages.push(message);
      conversation.updatedAt = stamp();
      id = conversation.id;
    });
    return id;
  }
}
