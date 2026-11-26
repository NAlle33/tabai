// @ts-check

/**
 * Keep valid fake-peer responses tied to the production wire contract.
 * Deliberately malformed frames should use JSON.stringify directly.
 * @param {import("../shared/protocol.js").ToolResponse} response
 */
export function serializeToolResponse(response) {
  return JSON.stringify(response);
}
