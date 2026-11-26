// The server's on-disk store: recipes, saved PDFs and GIFs. `CCMCP_CONFIG_DIR`
// overrides the per-user default so test runs (the CI harness) never write into
// the real store. Node-only. Logs have their own override (CCMCP_LOG_DIR, see
// logger.ts); the optional token / extension-id pin stay under the home dir.
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR = process.env.CCMCP_CONFIG_DIR || join(homedir(), ".claude-chrome-mcp");
export const RECIPES_FILE = join(CONFIG_DIR, "recipes.json");
export const PDF_DIR = join(CONFIG_DIR, "pdfs");
export const GIF_DIR = join(CONFIG_DIR, "gifs");
