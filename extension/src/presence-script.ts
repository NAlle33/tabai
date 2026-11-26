// Serialized by chrome.scripting: keep the renderer entirely self-contained.
// `owner` and `originMarker` are keyed hashes computed by the worker (of origin
// plus session, and of the origin): the page never sees a session or extension ID.
export async function renderPresence(
  owner: string,
  mode: "working" | "waiting" | "idle" | "hidden" | "remove",
  logo: string,
  originMarker: string,
): Promise<boolean> {
  type Surface = { owner: string; host: HTMLElement; root: ShadowRoot };
  const scope = window as unknown as { __ccmcpPresence?: Surface };
  let surface = scope.__ccmcpPresence;
  const marker = `${originMarker}:${owner}`;
  if (!surface) {
    // Reloading the extension replaces its isolated world but leaves its DOM
    // behind. Retire any older Tabai surface on this origin before creating or
    // hiding a fresh one; removing a degrouped tab's UI stays scoped to this
    // exact owner.
    const visibleOrHiding = mode === "working" || mode === "waiting" || mode === "idle" || mode === "hidden";
    // An earlier version wrote `<extension id>:<session id>`. Such a surface was
    // painted before this worker started, so it is stale whoever owns the tab now.
    // The ID is read here, in the isolated world, and is never written to the page.
    const extensionId = (globalThis as { chrome?: { runtime?: { id?: string } } }).chrome?.runtime?.id;
    for (const node of document.querySelectorAll("div[data-ccmcp-presence]")) {
      const value = node.getAttribute("data-ccmcp-presence");
      if (value === marker || (visibleOrHiding && value?.startsWith(`${originMarker}:`))
        || (extensionId && value?.startsWith(`${extensionId}:`))) node.remove();
    }
  }
  if (mode === "remove") {
    if (surface?.owner === owner) {
      surface.host.remove();
      delete scope.__ccmcpPresence;
    }
    return false;
  }
  if (mode === "hidden") {
    // The coordinator has validated the tab's current owner. A retained badge
    // from its previous owner must also disappear before capture is allowed.
    if (surface && surface.owner !== owner) {
      surface.host.remove();
      delete scope.__ccmcpPresence;
      return false;
    }
    if (surface?.owner === owner) {
      surface.host.dataset.state = "hidden";
      // captureVisibleTab reads the last composited frame, unlike CDP's fresh
      // render. Flush style and allow a paint before that fallback can run.
      void getComputedStyle(surface.host).display;
      await new Promise<void>(resolve => {
        let frame = 0;
        const finish = () => { clearTimeout(timer); cancelAnimationFrame(frame); resolve(); };
        const timer = setTimeout(finish, 100); // background tabs may suspend rAF
        frame = requestAnimationFrame(() => { frame = requestAnimationFrame(finish); });
      });
    }
    return false;
  }
  if (surface && surface.owner !== owner) {
    surface.host.remove();
    surface = undefined;
  }
  if (!document.documentElement) return false;
  if (!surface) {
    const host = document.createElement("div");
    host.setAttribute("data-ccmcp-presence", marker);
    host.setAttribute("aria-hidden", "true");
    host.inert = true;
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial !important; display: block !important; position: fixed !important; inset: 0 !important;
        width: auto !important; height: auto !important; z-index: 2147483647 !important;
        pointer-events: none !important; user-select: none !important; }
      *, *::before, *::after { box-sizing: border-box; pointer-events: none !important; }
      .edge { position: absolute; inset: 0; border: 2px solid transparent;
        border-radius: 8px; opacity: .28;
        background: linear-gradient(120deg,#1b4266,#8bd8ff,#6eb8ee,#1b4266) border-box;
        background-size: 300% 300%;
        mask: linear-gradient(#fff 0 0) padding-box, linear-gradient(#fff 0 0);
        mask-composite: exclude; }
      .badge { position: absolute; right: 16px; bottom: 16px; display: flex;
        align-items: center; gap: 9px; padding: 7px 12px 7px 7px;
        max-width: calc(100vw - 32px); border: 1px solid #c5d9ed;
        border-radius: 15px; background: #f4f9fff5; color: #153652;
        box-shadow: 0 3px 18px #132f4a20; font: 12px/1.3 system-ui,sans-serif; }
      canvas { width: 28px; height: 28px; border-radius: 8px; }
      .copy { display: grid; gap: 1px; }
      strong { font-weight: 650; font-size: 12px; letter-spacing: .15px; }
      .status { font-size: 10px; color: #45617c; }
      .dot { width: 5px; height: 5px; border-radius: 50%; background: #80b9de; margin-left: 7px; }
      :host([data-state="working"]) .edge { opacity: .85; animation: flow 7s ease-in-out infinite; }
      :host([data-state="working"]) .dot { background: #397ba7; }
      :host([data-state="waiting"]) .edge { opacity: .4; }
      :host([data-state="idle"]) .badge { opacity: .82; }
      :host([data-state="hidden"]) { display: none !important; }
      @keyframes flow { 0%,100% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } }
      @media (prefers-reduced-motion: reduce) { .edge { animation: none !important; } }
      @media print { :host { display: none !important; } }
    `;
    const edge = document.createElement("div");
    edge.className = "edge";
    const badge = document.createElement("div");
    badge.className = "badge";
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 48;
    const copy = document.createElement("div");
    copy.className = "copy";
    const brand = document.createElement("strong");
    brand.textContent = "Tabai";
    const status = document.createElement("span");
    status.className = "status";
    const dot = document.createElement("span");
    dot.className = "dot";
    copy.append(brand, status);
    badge.append(canvas, copy, dot);
    root.append(style, edge, badge);
    surface = { owner, host, root };
    scope.__ccmcpPresence = surface;
    // Decode the bundled logo without an image URL: page img-src CSP cannot
    // block the brand, and no web-accessible extension resource is needed.
    if (logo) {
      const bitmap = await createImageBitmap(new Blob([
        Uint8Array.from(atob(logo), char => char.charCodeAt(0)),
      ], { type: "image/png" }));
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
      bitmap.close();
    }
  }
  const { host, root } = surface;
  if (!host.isConnected) document.documentElement.append(host);
  host.dataset.state = mode;
  root.querySelector(".status")!.textContent = mode === "working" ? "Arbetar" : mode === "waiting" ? "Väntar" : "Redo";
  return true;
}
