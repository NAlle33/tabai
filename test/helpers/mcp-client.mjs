import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Each suite supplies its identity, environment, cwd and SDK options explicitly.
export const createMcpClient = (...args) => new Client(...args);
export const createMcpTransport = options => new StdioClientTransport(options);
export async function connectMcpClient(client, transport) {
  try { await client.connect(transport); }
  catch (error) {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    throw error;
  }
}
// Keep negative cases and binary/structured content observable to the caller.
export const callRaw = (client, ...args) => client.callTool(...args);
export const textContent = result => (result.content ?? []).filter(item => item.type === "text").map(item => item.text).join("\n");
