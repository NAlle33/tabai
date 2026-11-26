import { AssistantBrowser } from './assistant-browser';

/** Uses the ordinary MCP server rather than maintaining a second browser catalogue. */
export class AssistantMcpBrowser {
  private activity: string[] = [];
  constructor(private browser: Pick<AssistantBrowser, 'callRaw' | 'listTools' | 'close'>, private windowId?: number) {}

  async tools(input: { name?: string; offset: number; limit: number }) {
    const { tools } = await this.browser.listTools();
    if (input.name) {
      const tool = tools.find(tool => tool.name === input.name);
      if (!tool) throw new Error('Verktyget finns inte i Tabais MCP-katalog.');
      return { tools: [tool] };
    }
    const nextOffset = input.offset + input.limit;
    return { names: tools.map(tool => tool.name), tools: tools.slice(input.offset, nextOffset),
      ...(nextOffset < tools.length ? { nextOffset } : {}) };
  }

  async call(name: string, args: Record<string, unknown>) {
    // An early refusal only: it sees this outer call, not a path a batch or recipe assembles later.
    // The boundary is the server's deny root, which checks every bound path it gives a page.
    if (JSON.stringify(args).toLowerCase().includes('zoho-mail-oauth')) throw new Error('Den filen är privat och kan inte användas av webbläsarverktyg.');
    const { tools } = await this.browser.listTools();
    if (!tools.some(tool => tool.name === name)) throw new Error('Verktyget finns inte i Tabais MCP-katalog.');
    // Diagnostics and server-only tools must also work without an owned tab group.
    // Only an explicit group creation gets the initiating panel's window default.
    const arguments_ = name === 'tabs_context_mcp' && args.createIfEmpty === true && args.createWindowId === undefined && args.incognito !== true && this.windowId !== undefined
      ? { ...args, createWindowId: this.windowId } : args;
    this.activity.push(`Full Tabai-åtkomst: ${name}`);
    if (this.activity.length > 200) this.activity.shift();
    return this.browser.callRaw(name, arguments_);
  }

  drainActivity(): string[] { return this.activity.splice(0); }
  close(): Promise<void> { return this.browser.close(); }
}
