// Compile-only checks, included by npm run typecheck. No emitted runtime test.
import { serializeToolResponse } from "./protocol-fixtures.mjs";

serializeToolResponse({ id: "success", ok: true, result: { echoed: "navigate" } });
serializeToolResponse({ id: "null-result", ok: true, result: null });
serializeToolResponse({ id: "error", ok: false, error: { code: "SW_ERROR", message: "worker stopped" } });
serializeToolResponse({ id: "retryable", ok: false, error: { code: "NO_EXTENSION", message: "disconnected", retryable: true } });
// The protocol permits string codes beyond the built-in ToolErrorCode union.
serializeToolResponse({ id: "custom-code", ok: false, error: { code: "CUSTOM_ERROR", message: "fixture error", retryable: false } });

// @ts-expect-error Every response requires its correlation id.
serializeToolResponse({ ok: true, result: null });
// @ts-expect-error Correlation ids must be strings.
serializeToolResponse({ id: 1, ok: true, result: null });
// @ts-expect-error A successful response requires result.
serializeToolResponse({ id: "missing-result", ok: true });
// @ts-expect-error The discriminant must be a boolean literal, not a string.
serializeToolResponse({ id: "bad-ok", ok: "true", result: null });
// @ts-expect-error An error response cannot carry only a success result.
serializeToolResponse({ id: "wrong-variant", ok: false, result: null });
// @ts-expect-error Error codes are required.
serializeToolResponse({ id: "missing-code", ok: false, error: { message: "failure" } });
// @ts-expect-error Error messages are required.
serializeToolResponse({ id: "missing-message", ok: false, error: { code: "TOOL_ERROR" } });
// @ts-expect-error Error codes must be strings.
serializeToolResponse({ id: "bad-code", ok: false, error: { code: 123, message: "failure" } });
// @ts-expect-error Error messages must be strings.
serializeToolResponse({ id: "bad-message", ok: false, error: { code: "TOOL_ERROR", message: 123 } });
// @ts-expect-error Optional retryability must be boolean.
serializeToolResponse({ id: "bad-retryable", ok: false, error: { code: "TOOL_ERROR", message: "failure", retryable: "yes" } });
