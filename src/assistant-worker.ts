import net from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { toolInputObject } from "../shared/stable-schemas";
import { ASSISTANT_FRAME_LIMIT, assistantToolReplyLimit, assistantToolTimeout, assistantToolDescriptions, assistantToolSchemas, assistantWorkerMode, assistantWorkerToolNames, assistantWorkerWebLevel, type AssistantToolName } from "./assistant-tools";

const socketPath = process.env.TABAI_ASSISTANT_SOCKET;
const secret = process.env.TABAI_ASSISTANT_SECRET;
if (!socketPath || !secret) throw new Error("Privat assistentanslutning saknas.");

function request(tool: AssistantToolName, args: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const frame = JSON.stringify({ secret, tool, args }) + "\n";
    if (Buffer.byteLength(frame) > ASSISTANT_FRAME_LIMIT) return reject(new Error("Assistentanropet är för stort."));
    const socket = net.createConnection(socketPath!);
    let buffer = "", ended = false;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Åtgärden tog för lång tid. Kontrollera utfallet före ett nytt försök.")); }, assistantToolTimeout(tool) - 5_000);
    socket.setEncoding("utf8");
    // Windows named pipes close both ends after shutdown; keep the request side
    // open until the host has answered the newline-delimited request.
    socket.on("connect", () => socket.write(frame));
    socket.on("data", chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > assistantToolReplyLimit(tool)) socket.destroy(new Error("Assistentens svar är för stort."));
    });
    socket.on("end", () => {
      ended = true;
      clearTimeout(timer);
      if (!buffer.trim()) { reject(new Error("Assistentanslutningen stängdes innan svaret var klart. Kontrollera utfallet före ett nytt försök.")); return; }
      let reply;
      try { reply = JSON.parse(buffer); }
      catch { reject(new Error("Assistentens svar var ofullständigt eller ogiltigt. Kontrollera utfallet före ett nytt försök.")); return; }
      try {
        if (!reply.ok) throw new Error(reply.status ? JSON.stringify({ status: reply.status, code: reply.code, message: reply.error }) : reply.error);
        resolve(reply.result);
      }
      catch (error) { reject(error); }
    });
    socket.on("error", error => { clearTimeout(timer); reject(error); });
    socket.on("close", () => {
      clearTimeout(timer);
      if (!ended) reject(new Error("Assistentanslutningen stängdes innan svaret var klart. Kontrollera utfallet före ett nytt försök."));
    });
  });
}

const server = new McpServer({ name: "tabai_assistant", version: "1.0.0" });
for (const name of assistantWorkerToolNames(assistantWorkerMode(process.env.TABAI_ASSISTANT_CHAT), assistantWorkerWebLevel(process.env.TABAI_ASSISTANT_WEB), process.env.TABAI_ASSISTANT_FULL_ACCESS === '1')) {
  const schema = assistantToolSchemas[name];
  server.registerTool(name, {
    // The SDK drops unknown keys; the handler's strict parse then sees only declared ones.
    description: assistantToolDescriptions[name], inputSchema: toolInputObject(schema.shape),
    // Results are already bounded by the host; a client must keep them inline rather
    // than spill mail text to a file the model cannot read (Claude Code reads this key).
    _meta: { "anthropic/maxResultSizeChars": assistantToolReplyLimit(name) },
    annotations: { readOnlyHint: ["workflow_context", "workflow_items", "browser_read", "browser_read_thread", "browser_find", "web_read", "web_find", "chat_files", "chat_profile", "mcp_browser_tools"].includes(name), destructiveHint: name === "browser_send_approved" || name === 'mcp_browser_call', openWorldHint: name.startsWith("browser_") || name.startsWith("web_") || name === 'mcp_browser_call' },
  }, async (args: any) => {
    try {
      const result = await request(name, schema.parse(args));
      return name === 'mcp_browser_call' ? CallToolResultSchema.parse(result) : { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
    catch (error) { return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Assistentverktyget misslyckades." }] }; }
  });
}
await server.connect(new StdioServerTransport());
