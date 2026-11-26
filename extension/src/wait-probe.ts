export type SelectorWaitState = "attached" | "visible" | "hidden" | "detached";

/** Only condition metadata crosses into observations: never page text, field
 * values, predicate source or the predicate's raw completion value. */
export interface WaitObservation {
  status: "matched" | "unmatched" | "predicate-error" | "selector-error" | "field-error" | "capture-unavailable";
  matched?: boolean;
  matchCount?: number;
  visible?: boolean;
  state?: SelectorWaitState;
  valueMatches?: boolean;
  captureActive?: boolean;
  inflight?: number;
}

export interface WaitProbeResult {
  ok: boolean;
  kind: string;
  reason?: string;
  note?: string;
  fatal?: string;
  diagnostic?: string;
  observation?: WaitObservation;
}

/** One synchronous probe, serialized into the page with func.toString(). Keep
 * every runtime helper inside this function. The worker owns all timing. */
export function checkWaitForInPage(
  kind: string,
  value: string | { selector: string; value: string | number | boolean },
  state: SelectorWaitState = "attached",
): WaitProbeResult {
  if (kind === "network_idle" && typeof (window as any).__ccmcpInflight !== "number") {
    if (location.protocol === "http:" || location.protocol === "https:") {
      return { ok: false, kind, reason: "network capture not active — reload the page after loading the extension",
        observation: { status: "capture-unavailable", captureActive: false } };
    }
    return { ok: true, kind, note: "no network capture on this document — treated as idle",
      observation: { status: "matched", captureActive: false } };
  }
  if (kind === "predicate") {
    try {
      // Validation uses Script grammar before dispatch. A Promise completion is
      // intentionally truthy: predicates retain their synchronous contract.
      const ok = !!(0, eval)(value as string);
      return { ok, kind, observation: { status: ok ? "matched" : "unmatched", matched: ok } };
    } catch (error: any) {
      const name = String(error?.name ?? "");
      const message = String(error?.message ?? error ?? "").slice(0, 500);
      if (/content security policy/i.test(message)) {
        return { ok: false, kind, fatal: `the page refused to evaluate the predicate: ${message}` };
      }
      return { ok: false, kind, diagnostic: `${name || "Error"}: ${message}`.slice(0, 500),
        observation: { status: "predicate-error", matched: false } };
    }
  }
  let ok = false;
  let observation: WaitObservation | undefined;
  try {
    if (kind === "selector") {
      const matches = document.querySelectorAll(value as string);
      // Selectors may intentionally match a collection: visible means any
      // visible match, hidden means every match is hidden (or none exists).
      const visible = Array.from(matches).some(el => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse" &&
          rect.width > 0 && rect.height > 0;
      });
      const attached = matches.length > 0;
      ok = state === "visible" ? visible : state === "hidden" ? !visible
        : state === "detached" ? !attached : attached;
      observation = { status: ok ? "matched" : "unmatched", matched: attached, matchCount: matches.length, visible, state };
    } else if (kind === "text") ok = (document.body?.innerText || "").includes(value as string);
    else if (kind === "url") ok = location.href === value;
    else if (kind === "field_value") {
      const field = value as { selector: string; value: string | number | boolean };
      const matches = document.querySelectorAll(field.selector);
      observation = { status: "unmatched", matched: matches.length > 0, matchCount: matches.length, valueMatches: false };
      if (matches.length > 1) return { ok: false, kind, fatal: "fieldValue selector is ambiguous (matched multiple elements)", observation };
      const el = matches[0] as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | undefined;
      if (!el) return { ok: false, kind, observation };
      if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
        if (typeof field.value !== "boolean") return { ok: false, kind, fatal: "checkbox/radio fieldValue requires a boolean value", observation };
        ok = el.checked === field.value;
      } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        ok = el.value === String(field.value);
      } else {
        return { ok: false, kind, fatal: "fieldValue selector must match an input, textarea, or select", observation };
      }
      observation.valueMatches = ok;
    } else if (kind === "network_idle") {
      const inflight = (window as any).__ccmcpInflight;
      ok = inflight === 0;
      observation = { status: ok ? "matched" : "unmatched", captureActive: true,
        ...(Number.isFinite(inflight) ? { inflight } : {}) };
    }
  } catch {
    if (kind === "selector") return { ok: false, kind, fatal: "selector is invalid or could not be read",
      observation: { status: "selector-error" } };
    if (kind === "field_value") return { ok: false, kind, fatal: "fieldValue selector is invalid or could not be read",
      observation: { status: "field-error" } };
    // Other conditions can become readable as the document settles.
  }
  observation ??= { status: ok ? "matched" : "unmatched", matched: ok };
  observation.status = ok ? "matched" : "unmatched";
  return { ok, kind, observation };
}
