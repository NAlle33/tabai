import { BUILD_ID } from "../shared/build-info";
import { MIN_EXTENSION_VERSION, compareVersions } from "../shared/protocol";
import type { BridgeClient } from "./bridge-client";
import type { PanelDiagnostics, DiagnosticSnapshot } from "../shared/diagnostics";

export async function collectHealth(bridge: Pick<BridgeClient, "connected" | "pendingCount" | "call"> & { brokerBuildId?: string }, serverVersion: string, observe = true) {
  const brokerBuildId = bridge.brokerBuildId;
  const base = { bridgeConnected: bridge.connected, pending: bridge.pendingCount, serverVersion, serverBuildId: BUILD_ID, brokerBuildId,
    brokerBuildStatus: !brokerBuildId ? "unknown" : brokerBuildId === BUILD_ID ? "matching" : "mismatched" };
  if (!bridge.connected) return { ...base, extension: "disconnected" as const };
  try {
    const extension = await bridge.call("health", {}, 1500, observe) as {
      extVersion?: string; buildId?: string; diagnostics?: DiagnosticSnapshot;
    };
    const extVersion = typeof extension?.extVersion === "string" ? extension.extVersion : "0.0.0";
    const stale = compareVersions(extVersion, MIN_EXTENSION_VERSION) < 0;
    const buildMismatch = (typeof extension?.buildId === "string" && extension.buildId !== BUILD_ID) || (!!brokerBuildId && brokerBuildId !== BUILD_ID);
    const refresh: Array<"broker" | "extension"> = [];
    if (!brokerBuildId || brokerBuildId !== BUILD_ID) refresh.push("broker");
    if (!extension?.buildId || extension.buildId !== BUILD_ID) refresh.push("extension");
    return { ...base, extension,
      ...(stale ? { staleExtension: true, note: `Running extension ${extVersion} < required ${MIN_EXTENSION_VERSION} — reload the extension before using new capabilities.` } : {}),
      refresh,
      ...(buildMismatch ? { buildMismatch: true, buildNote: "Peers differ from this running MCP server. Refresh the listed peers from the intended build; restart this MCP server too if it is stale." } : {}),
    };
  } catch (error) {
    return { ...base, extension: { error: String((error as Error)?.message ?? error) } };
  }
}

export function panelDiagnostics(health: Awaited<ReturnType<typeof collectHealth>>): PanelDiagnostics {
  const extension = health.extension;
  const details = typeof extension === "object" && extension !== null && "buildId" in extension ? extension : undefined;
  return { serverBuildId: health.serverBuildId,
    brokerBuildId: health.brokerBuildId,
    refresh: "refresh" in health ? health.refresh : (!health.brokerBuildId ? ["broker"] : []),
    extensionBuildId: typeof details?.buildId === "string" ? details.buildId : undefined,
    buildMismatch: "buildMismatch" in health && health.buildMismatch === true,
    available: !!details?.diagnostics,
    ...(details?.diagnostics ? { operations: details.diagnostics } : {}),
  };
}
