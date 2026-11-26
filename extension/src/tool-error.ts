// A tool failure with a machine-readable code the SW envelope forwards to the
// server (and on to the agent as "CODE: message", with retryability threaded).
// SW-side only — injected page scripts have no module scope, so they can't use
// this; they return {ok:false,error} payloads instead.
export class ToolError extends Error {
  code: string;
  retryable: boolean;
  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.retryable = retryable;
  }
}

/** A VALIDATION failure on the CDP interaction path (unknown key name, nothing
 *  focused to type into). The synthetic-event fallback would repeat the same
 *  mistake and report ok, so toolComputer rethrows this instead of falling back.
 *  Trusted keyboard input also refuses fallback on transport failures. */
export class NoFallbackError extends ToolError {
  constructor(message: string) {
    super("TOOL_ERROR", message);
    this.name = "NoFallbackError";
  }
}
