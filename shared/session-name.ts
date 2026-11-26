/** A display label only; session identity always comes from the broker. */
export function normalizeSessionName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, 64).trim();
  return name || undefined;
}

export function groupTitle(_sessionId: string, sessionName?: string): string {
  return normalizeSessionName(sessionName) ?? "Tabai";
}
