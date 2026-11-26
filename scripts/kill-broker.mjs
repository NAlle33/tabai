// Kill the broker daemon (and any stray squatting its ports) so it re-spawns
// clean on the next tool call. The broker owns the extension port (9223) + the
// client port (9225). Pure Node, no deps.
import { killPort } from "../test/kill-port.mjs";

const EXT_PORT = process.env.CCMCP_PORT || "9223";
const CLIENT_PORT = process.env.CCMCP_CLIENT_PORT || "9225";

console.log(`killing broker + any squatters on :${CLIENT_PORT} and :${EXT_PORT}…`);
killPort(CLIENT_PORT);
killPort(EXT_PORT);
console.log("done — the broker re-spawns automatically on the next tool call.");
