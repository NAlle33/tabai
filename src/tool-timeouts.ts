// Preserve the distinct direct/workflow timeout contracts at one owner.
export function bridgeTimeoutFor(
  source: "direct" | "workflow", tool: string, args: Record<string, unknown>,
): number | undefined {
  const timeout = typeof args.timeoutMs === "number" ? args.timeoutMs : undefined;
  if (tool === "wait_for") return (timeout ?? 15_000) + 2_000;
  if (tool === "download") {
    if (source === "direct" && args.action === "arm") return undefined;
    return (timeout ?? 30_000) + 5_000;
  }
  if (tool === "navigate" || tool === "tab_reload") return 35_000;
  if (tool === "gif_creator" && args.action === "export") return 90_000;
  return undefined;
}
