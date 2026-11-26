// Server-side port resolution. A RUNTIME env override (CCMCP_PORT /
// CCMCP_CLIENT_PORT) wins over the build-time define — so tests, CI, and
// throwaway instances can bind isolated ports without touching the user's live
// 9223/9225. Node-only: the extension bundle has no process.env and keeps using
// the shared/protocol build constants directly.
import {
  BRIDGE_HOST,
  BRIDGE_PORT as DEFINE_BRIDGE_PORT,
  CLIENT_PORT as DEFINE_CLIENT_PORT,
} from "../shared/protocol";
import { intEnv } from "./env";

function port(name: string, fallback: number): number {
  const value = intEnv(name, NaN, 1, 65535);
  if (process.env[name] !== undefined && !Number.isFinite(value)) {
    throw new Error(`${name} must be an integer from 1 to 65535`);
  }
  if (Number.isFinite(value)) return value;
  if (!Number.isInteger(fallback) || fallback < 1 || fallback > 65535) {
    throw new Error(`${name} has an invalid build-time port; rebuild with a valid value`);
  }
  return fallback;
}
export const BRIDGE_PORT = port("CCMCP_PORT", DEFINE_BRIDGE_PORT);
export const CLIENT_PORT = port("CCMCP_CLIENT_PORT", DEFINE_CLIENT_PORT);
export { BRIDGE_HOST };
