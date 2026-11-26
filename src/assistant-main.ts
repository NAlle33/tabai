import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { moduleInputSchema, moduleOperationSchema } from "../shared/personal-modules";
import { AssistantController } from "./assistant-controller";
import { AssistantModuleClient } from './assistant-module-client';

const root = resolve(process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), ".."));
const configDir = process.env.CCMCP_MODULE_CONFIG_DIR || join(homedir(), ".claude-chrome-mcp");
const modules = new AssistantModuleClient(frame => { process.stdout.write(JSON.stringify(frame) + '\n'); });
const controller = new AssistantController(root, join(configDir, "assistant"), undefined, {
  notice: notice => { process.stdout.write(JSON.stringify({ type: "assistant-notice", notice }) + "\n"); },
  module: command => modules.request(command),
});
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let closing = false;
input.on("line", line => {
  if (Buffer.byteLength(line) > 2 * 1024 * 1024) { void close(); return; }
  void (async () => {
    let id: unknown;
    try {
      const frame = JSON.parse(line); id = frame.id;
      if (modules.receive(frame)) return;
      if (Buffer.byteLength(line) > 1_000_000) throw new Error('Invalid frame');
      if (typeof id !== "string" || id.length > 100) throw new Error("Invalid frame");
      const result = await controller.request(moduleOperationSchema.parse(frame.operation), moduleInputSchema.parse(frame.input));
      process.stdout.write(JSON.stringify({ id, ok: true, result }) + "\n");
    } catch (error) {
      // Error messages contain no raw input, model output or provider page content.
      process.stdout.write(JSON.stringify({ id, ok: false, error: error instanceof Error && !("issues" in error) ? error.message : "Kontrollera uppgifterna och försök igen." }) + "\n");
    }
  })();
});
async function close() {
  if (closing) return; closing = true; input.close(); modules.close();
  await controller.close(); process.exit(0);
}
input.on("close", () => void close());
process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
