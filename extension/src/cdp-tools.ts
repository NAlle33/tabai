import { cdpSend } from "./cdp";
import { assertTabInGroup, sessionOf } from "./tab-group-helpers";
import { armDownload, collectDownload } from "./download-state";
import { extensionHealth } from "./health";

// ---- health -----------------------------------------------------------------
// Extension-side state for the server's `health` tool. No tabId → no group gate
// (read-only meta).
export async function toolHealth(args: unknown) {
  return extensionHealth(sessionOf(args));
}


// ---- print_to_pdf -----------------------------------------------------------
export async function toolPrintToPdf(args: {
  tabId: number;
  landscape?: boolean;
  printBackground?: boolean;
  scale?: number;
}) {
  await assertTabInGroup(sessionOf(args), args.tabId);
  const r = await cdpSend<{ data: string }>(args.tabId, "Page.printToPDF", {
    landscape: args.landscape ?? false,
    printBackground: args.printBackground ?? true,
    scale: args.scale ?? 1,
    transferMode: "ReturnAsBase64",
  });
  if (!r?.data) throw new Error("Page.printToPDF returned no data");
  return { kind: "pdf", base64: r.data };
}


// ---- cookies (read / domain-scoped clear) -----------------------------------
export async function toolCookies(args: {
  tabId: number;
  action: "get" | "clear";
  domain?: string;
}) {
  const tab = await assertTabInGroup(sessionOf(args), args.tabId);
  const url = tab.url || "";
  const getCookies = async () => {
    const r = await cdpSend<{ cookies: any[] }>(
      args.tabId,
      "Network.getCookies",
      url ? { urls: [url] } : {},
    );
    return r?.cookies ?? [];
  };

  if (args.action === "get") {
    const cookies = (await getCookies()).map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
    }));
    return { count: cookies.length, cookies };
  }

  // clear — browser-wide ONLY when domain === "*".
  if (args.domain === "*") {
    await cdpSend(args.tabId, "Network.clearBrowserCookies");
    return { ok: true, cleared: "all-browser-cookies" };
  }
  // Fail CLOSED: without a tab URL to scope to AND no explicit domain, getCookies({})
  // would return cross-frame cookies — refuse rather than over-delete.
  if (!url && !args.domain) {
    return {
      ok: false,
      error:
        "No resolvable tab URL to scope the clear. Pass `domain`, or domain='*' for all browser cookies.",
    };
  }
  // Candidates are already scoped to the tab's URL (host + applicable parent
  // domains). With no `domain`, delete them all (a proper logout). With `domain`,
  // narrow by a real domain boundary (no suffix false-matches like evil-example).
  const cookies = await getCookies();
  let toDelete = cookies;
  if (args.domain) {
    const h = args.domain.replace(/^\./, "");
    toDelete = cookies.filter((c) => {
      const d = String(c.domain).replace(/^\./, "");
      return d === h || d.endsWith("." + h);
    });
  }
  let deleted = 0;
  for (const c of toDelete) {
    await cdpSend(args.tabId, "Network.deleteCookies", {
      name: c.name,
      domain: c.domain,
      path: c.path,
    });
    deleted++;
  }
  return { ok: true, cleared: args.domain || "(tab cookies)", deleted };
}


// ---- emulate_device (size / DPR / mobile) -----------------------------------
export async function toolEmulateDevice(args: {
  tabId: number;
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  mobile?: boolean;
  reset?: boolean;
}) {
  await assertTabInGroup(sessionOf(args), args.tabId);
  if (args.reset) {
    await cdpSend(args.tabId, "Emulation.clearDeviceMetricsOverride");
    return { ok: true, reset: true };
  }
  if (args.width == null || args.height == null) {
    throw new Error("emulate_device needs width + height (or reset:true)");
  }
  const deviceScaleFactor = args.deviceScaleFactor ?? 1;
  const mobile = args.mobile ?? false;
  await cdpSend(args.tabId, "Emulation.setDeviceMetricsOverride", {
    width: args.width,
    height: args.height,
    deviceScaleFactor,
    mobile,
  });
  return { ok: true, width: args.width, height: args.height, deviceScaleFactor, mobile };
}


// ---- download (arm before trigger, then collect) — via chrome.downloads ------
// CDP Page.setDownloadBehavior is rejected ("Cannot access browser-level commands")
// in stable Chrome, and Page.download* events are deprecated. chrome.downloads is
// the stable API: arm starts capturing the NEXT download; the operator triggers
// it; collect waits for completion and returns the real saved path (the file
// lands in the browser's normal download folder).
//
// One session owns the browser-wide arm at a time; an expired owner can be
// replaced atomically. chrome.downloads exposes no originating tab, so an
// unrelated browser download can consume that arm. Collection stays scoped to
// the owning session's captureId.
export async function toolDownload(args: {
  action: "arm" | "collect";
  tabId: number;
  timeoutMs?: number;
}) {
  const sid = sessionOf(args);
  await assertTabInGroup(sid, args.tabId);
  return args.action === "arm" ? armDownload(sid) : collectDownload(sid, args.timeoutMs);
}
