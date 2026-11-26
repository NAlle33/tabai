

// Functions injected into the page via chrome.scripting.executeScript.
//
// CRITICAL: each of these is serialized by func.toString() and runs in the
// page. They must be FULLY self-contained — no imports, no module-scope refs,
// only their own params + page globals (document, window, MouseEvent, ...).
// (See the chrome-scripting-serialization gotcha.) Elements are typed `any`
// inside because they run in the page, not under our DOM lib types.
//
// DUPLICATED RESOLVER — injected functions cannot import module scope. Keep
// form/fill/select, pageInteract, actionability, perception and element-ref's
// serialized resolver synchronized: require this document's opaque namespace,
// the original live identity-map node and one exact attribute match across open
// shadow roots. DOM attributes alone never authenticate a reference. Refs are
// per frame and never fall through to another frame. CDP reference evaluation
// uses the extension's exact ISOLATED context, not MAIN-world attribute lookup.
// Any algorithm change must update every consumer.
//
// DUPLICATED PREDICATES — same rule, same sync list:
// - `isSecretField`: pageQuery (masks the value and never names a secret field
//   after its own text), formInputInPage / fillFormInPage (mask read-back
//   errors) and `secret` in perception-scripts.ts. An input or textarea is
//   secret by type password/hidden, by any autocomplete token current-password,
//   new-password, one-time-code or cc-*, or by pass/otp/cvv/cvc in name or id.
//   The autocomplete-token rule is also in src/assistant-web.ts: the fill
//   refusal in classifyAssistantWebTarget, the payment detection in
//   webElementScript and the masking in webFormStateScript (their name rules
//   are the assistant's own).
// - the walk bounds: pageQuery and perceiveInPage stop at depth 512 or after
//   20 000 elements and say so ("walk aborted" / truncated).
// - accessible names bounded to 500 characters: pageQuery and perception's nameOf;
//   names never include a textarea's text: pageQuery's boundedText and perception's
//   text(), which both also read the label, label[for] and aria-labelledby names.
// - the checkbox/radio + read-back logic (formInputInPage / fillFormInPage).
// - the point hit test, the enabled test and the key-chord parser: see the
//   banner of injected-interaction-scripts.ts.

/**
 * read_page (mode "read") + find (mode "find").
 * Tags chosen elements with a stable data-ccmcp-ref and returns text lines
 * `[ref_N] role "name" value="…"`. Refs persist across calls (counter on
 * window) so form_input/computer can resolve them later.
 */
export function pageQuery(
  mode: "read" | "find",
  query: string,
  filter: "interactive" | "all",
  maxResults: number,
): string {
  const ATTR = "data-ccmcp-ref";
  const w = window as any;
  // A ref identifies one issued node in one document, even after navigation.
  if (w.__ccmcpRefState?.document !== document ||
      !/^\d{40}$/.test(w.__ccmcpRefState?.namespace ?? "") ||
      !Number.isSafeInteger(w.__ccmcpRef) || w.__ccmcpRef < 0 ||
      !w.__ccmcpRefMap || typeof w.__ccmcpRefMap !== "object") {
    const random = crypto.getRandomValues(new Uint32Array(4));
    w.__ccmcpRefState = { document, namespace: Array.from(random, n => String(n).padStart(10, "0")).join("") };
    w.__ccmcpRef = 0;
    w.__ccmcpRefMap = Object.create(null);
  }
  const namespace = w.__ccmcpRefState.namespace;
  const map = w.__ccmcpRefMap;
  // Removed/adopted nodes never transfer their identity to a cloned attribute.
  for (const ref of Object.keys(map)) {
    if (!map[ref]?.isConnected || map[ref].ownerDocument !== document) delete map[ref];
  }


  // Own + near-descendant text, BOUNDED: at most `max` chars, three levels deep,
  // skipping wide containers, script/style and textareas (a textarea's text is
  // its value, possibly a secret one — never a label, as in perception's text()).
  // Naming every visible element this way stays O(n) over a big page — innerText
  // forces a layout per call and made find / read_page "all" O(n × subtree)
  // (multi-second hangs on large DOMs).
  const boundedText = (el: any, max = 200): string => {
    if (el.childElementCount > 50) return "";
    let out = "";
    const visit = (n: any, depth: number) => {
      for (const c of Array.from(n.childNodes) as any[]) {
        if (out.length >= max) return;
        if (c.nodeType === 3) out += c.textContent;
        else if (c.nodeType === 1 && depth < 3 && c.childElementCount <= 50 && !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TEXTAREA)$/.test(c.tagName)) {
          visit(c, depth + 1);
        }
      }
    };
    visit(el, 0);
    return out.replace(/\s+/g, " ").trim().slice(0, max);
  };

  // Secret fields (passwords, one-time codes, card data — by type, any
  // autocomplete token, or a pass/otp/cvv/cvc name) are listed but their VALUE
  // is never printed: an autofilled password would otherwise land in the model
  // transcript. Duplicated in formInputInPage / fillFormInPage (read-back
  // errors) and perception's `secret` (see the file banner).
  const isSecretField = (el: any): boolean => {
    const tag = el.tagName.toLowerCase();
    if (tag !== "input" && tag !== "textarea") return false;
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "password" || type === "hidden") return true;
    const tokens: string[] = (el.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/);
    if (tokens.some(token => token === "current-password" || token === "new-password" || token === "one-time-code" || token.startsWith("cc-"))) return true;
    return /pass|otp|cvv|cvc/i.test((el.getAttribute("name") || "") + " " + (el.id || ""));
  };

  // Label text is read with boundedText, as perception's nameOf reads it with
  // text(): a label or labelling element may hold a textarea, whose text is a
  // value (a recovery code, say), never part of a name.
  const fullName = (el: any): string => {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const s = labelledby
        .split(/\s+/)
        .map((id: string) => {
          const label = document.getElementById(id);
          return label ? boundedText(label, 500) : "";
        })
        .join(" ")
        .trim();
      if (s) return s;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") {
      if (el.id) {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        const forName = l ? boundedText(l, 500) : "";
        if (forName) return forName;
      }
      const wrap = el.closest("label");
      const wrapName = wrap ? boundedText(wrap, 500) : "";
      if (wrapName) return wrapName;
      if (el.getAttribute("placeholder")) return el.getAttribute("placeholder");
      if (el.getAttribute("name")) return el.getAttribute("name");
    }
    if (tag === "img") {
      const alt = el.getAttribute("alt");
      if (alt) return alt;
    }
    if (el.getAttribute("title")) return el.getAttribute("title");
    // A textarea's own text is its value: a secret field is never named after it.
    return isSecretField(el) ? "" : boundedText(el).slice(0, 120);
  };
  // Bounded like perception's nameOf: one huge label cannot flood the listing.
  const accName = (el: any): string => fullName(el).slice(0, 500);

  const roleOf = (el: any): string => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (["button", "submit", "reset", "image"].includes(t)) return "button";
      return "textbox";
    }
    const map: Record<string, string> = {
      a: "link",
      button: "button",
      select: "combobox",
      textarea: "textbox",
      img: "img",
      nav: "navigation",
      main: "main",
      header: "banner",
      footer: "contentinfo",
      h1: "heading",
      h2: "heading",
      h3: "heading",
      h4: "heading",
      h5: "heading",
      h6: "heading",
    };
    return map[tag] || tag;
  };

  const isInteractive = (el: any): boolean => {
    const tag = el.tagName.toLowerCase();
    if (["a", "button", "input", "select", "textarea"].includes(tag))
      return true;
    const r = el.getAttribute("role");
    if (
      r &&
      [
        "button",
        "link",
        "checkbox",
        "radio",
        "menuitem",
        "tab",
        "switch",
        "combobox",
        "option",
      ].includes(r)
    )
      return true;
    if (el.hasAttribute("onclick")) return true;
    const ti = el.getAttribute("tabindex");
    if (ti !== null && parseInt(ti, 10) >= 0) return true;
    if (el.isContentEditable) return true;
    return false;
  };

  const isVisible = (el: any): boolean => {
    // Rect first: display:none + collapsed elements are 0x0, so we reject them
    // without the more expensive getComputedStyle (big win on large DOMs).
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    // A control behind a modal (aria-hidden / inert subtree) or in a subtree the
    // page hid with the `hidden` attribute is not operable — listing it invites a
    // click that goes "through" the overlay.
    if (el.closest && el.closest('[aria-hidden="true"],[inert],[hidden]')) return false;
    // Non-zero rect can still be visibility:hidden — check only then.
    return getComputedStyle(el).visibility !== "hidden";
  };

  const refOf = (el: any): string => {
    let ref = el.getAttribute(ATTR);
    if (!ref || !/^ref_\d{50}$/.test(ref) || ref.slice(4, 44) !== namespace || map[ref] !== el) {
      if (w.__ccmcpRef >= 9_999_999_999) throw new Error("Reference counter exhausted; reload the page");
      ref = `ref_${namespace}${String(++w.__ccmcpRef).padStart(10, "0")}`;
      el.setAttribute(ATTR, ref);
    }
    map[ref] = el;
    return ref;
  };


  // Deep walk: light DOM + open shadow roots. Tracks depth for a hierarchical
  // (a11y-tree-like) read_page. Bounded like perception's walk and guarded: a
  // hostile or pathological DOM yields a partial listing plus a marker, never an
  // exception with no output at all. Real pages nest past 60 (Gmail's reply box
  // reaches 67); 512 is where Chromium's own HTML parser stops nesting, and the
  // element cap keeps one call from becoming an unbounded page operation.
  const MAX_DEPTH = 512;
  const MAX_ELEMENTS = 20_000;
  const candidates: any[] = [];
  let walkAborted = false;
  let visited = 0;
  const walk = (root: any, depth: number) => {
    if (depth > MAX_DEPTH) {
      walkAborted = true;
      return;
    }
    const kids = root && root.children ? (Array.from(root.children) as any[]) : [];
    for (const el of kids) {
      if (visited >= MAX_ELEMENTS) {
        walkAborted = true;
        return;
      }
      visited++;
      let keep = isVisible(el);
      let name = "";
      let role = "";
      const inter = keep && isInteractive(el);
      if (keep) {
        if (mode === "read" && filter === "interactive" && !inter) keep = false;
        else {
          name = accName(el);
          role = roleOf(el);
          if (mode === "read" && filter === "all") {
            const structural = [
              "heading",
              "navigation",
              "main",
              "banner",
              "contentinfo",
            ].includes(role);
            if (!inter && !name && !structural) keep = false;
          }
          if (mode === "find" && !name && !inter) keep = false;
        }
      }
      if (keep) candidates.push({ el, role, name, inter, depth });
      walk(el, depth + 1);
      if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
      // NOTE: iframes are handled by injecting into every frame separately
      // (executeScript allFrames). The SW namespaces each frame's refs with
      // @frameId, so we must NOT also recurse into contentDocument here (would
      // double-tag same-origin frames + can't reach cross-origin ones anyway).
    }
  };
  try {
    walk(document.body, 0);
  } catch {
    walkAborted = true; // keep what was collected
  }

  let chosen: any[];
  if (mode === "find") {
    const q = (query || "").toLowerCase();
    const terms = q.split(/\s+/).filter(Boolean);
    if (!terms.length) return ""; // nothing to match — never "everything"
    chosen = candidates
      .map((c) => {
        const hay = (
          c.name +
          " " +
          c.role +
          " " +
          (c.el.getAttribute("placeholder") || "") +
          " " +
          (c.el.getAttribute("name") || "")
        ).toLowerCase();
        let score = 0;
        for (const t of terms) if (hay.includes(t)) score += 1;
        if (c.name.toLowerCase() === q) score += 5;
        if (c.inter) score += 0.5;
        return { c, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map((s) => s.c);
  } else {
    chosen = candidates.slice(0, maxResults);
  }

  const out = chosen
    .map((c) => {
      const ref = refOf(c.el);
      const raw = c.el.value;
      const v =
        raw !== undefined && raw !== "" && c.role !== "button"
          ? isSecretField(c.el)
            ? ` value="•••(${String(raw).length})"`
            : ` value="${String(raw).slice(0, 60)}"`
          : "";
      const nm = c.name ? ` "${c.name.replace(/"/g, "'")}"` : "";
      // read_page: indent by DOM depth → tree. find: flat (ranked by score).
      const indent = mode === "read" ? "  ".repeat(Math.min(c.depth, 12)) : "";
      return `${indent}[${ref}] ${c.role}${nm}${v}`;
    })
    .join("\n");
  return walkAborted ? out + "\n…(walk aborted)" : out;
}


/**
 * One synchronous wait_for probe in MAIN world. The service worker owns the
 * deadline and quiet interval so replacing this document cannot strand a wait.
 *
 * A predicate exception is CLASSIFIED rather than discarded: one that can never
 * succeed on a later poll (it does not parse, or the page refuses to evaluate a
 * string at all) is reported as `fatal` so the wait fails promptly instead of
 * timing out silently; anything that may settle as the page loads is reported as
 * a `diagnostic` the worker keeps for a final timeout message. Self-contained —
 * this whole function is serialized into the page.
 */
export { checkWaitForInPage } from "./wait-probe";


/** read_console_messages: read the buffer the content script populates. */
export function readConsoleInPage(): {
  installed: boolean;
  messages: { level: string; text: string; ts: number }[];
} {
  const w = window as any;
  return {
    installed: Boolean(w.__ccmcpConsoleInstalled),
    messages: Array.isArray(w.__ccmcpConsole) ? w.__ccmcpConsole.slice() : [],
  };
}


/** read_network_requests: read the buffer the content script populates. */
export function readNetworkInPage(): {
  installed: boolean;
  requests: {
    type: string;
    method: string;
    url: string;
    status: number;
    ms: number;
    ts: number;
    error?: string;
  }[];
} {
  const w = window as any;
  return {
    installed: Boolean(w.__ccmcpFetchWrapped || w.__ccmcpXhrWrapped),
    requests: Array.isArray(w.__ccmcpNetwork) ? w.__ccmcpNetwork.slice() : [],
  };
}


/** get_page_text: readable text of the page. A single <article> is the content;
 *  several (a listing page) mean none of them is — fall back to main/body. */
export function extractPageText(): string {
  const articles = document.querySelectorAll("article");
  const root =
    (articles.length === 1 ? articles[0] : null) ||
    document.querySelector("main") ||
    document.body;
  const text = (root as HTMLElement | null)?.innerText ?? "";
  const MAX = 100_000;
  return text.length > MAX ? text.slice(0, MAX) + "\n…(truncated)" : text;
}


/** javascript_tool: eval an expression in the page (MAIN world). Serialized into
 *  a Runtime.evaluate expression by page-evaluation.ts, which carries the CSP
 *  allowance a strict page needs and awaits this function's promise. A thenable
 *  result is awaited with a 25 s cap — below the 30 s bridge timeout, so the
 *  caller gets a message instead of a TIMEOUT; the page promise keeps running,
 *  nothing holds the worker. Results are probed for serializability up front so
 *  a DOM node / cycle / BigInt yields a clear error rather than
 *  "No result returned from page". */
export function evalInPage(
  code: string,
): { ok: boolean; value?: unknown; error?: string } | Promise<{ ok: boolean; value?: unknown; error?: string }> {
  const probe = (v: unknown): { ok: boolean; value?: unknown; error?: string } => {
    if (typeof Node !== "undefined" && v instanceof Node) {
      return { ok: false, error: "result is a DOM node — return a serializable value (e.g. its outerHTML or textContent)" };
    }
    if (typeof v === "function") return { ok: false, error: "result is a function — return a serializable value" };
    try {
      JSON.stringify(v);
    } catch (e: any) {
      return { ok: false, error: `result is not JSON-serializable: ${String(e?.message ?? e)}` };
    }
    return { ok: true, value: v === undefined ? null : v };
  };
  try {
    const value: any = (0, eval)(code);
    if (value && typeof value.then === "function") {
      let timer: any;
      const timeout = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error("expression promise did not settle in 25s")), 25_000);
      });
      return Promise.race([Promise.resolve(value), timeout]).then(
        (v) => {
          clearTimeout(timer);
          return probe(v);
        },
        (e: any) => {
          clearTimeout(timer);
          return { ok: false, error: String(e?.message ?? e) };
        },
      );
    }
    return probe(value);
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}


/** storage: read/write the tab's localStorage or sessionStorage (same-origin).
 *  Storage access can throw (sandboxed iframe, storage disabled) — caught +
 *  returned as a clear error, never thrown raw. Self-contained (no module scope). */
export function storageInPage(
  area: "local" | "session",
  action: "get" | "set" | "remove" | "clear",
  key?: string | null,
  value?: string | null,
): {
  ok: boolean;
  entries?: Record<string, string>;
  value?: string | null;
  truncated?: boolean;
  error?: string;
} {
  try {
    const store = area === "session" ? window.sessionStorage : window.localStorage;
    if (action === "get") {
      const CAP = 100_000;
      if (key != null) {
        // One key can hold a megabyte blob too — same cap as get-all.
        const v = store.getItem(key);
        if (v != null && v.length > CAP) return { ok: true, value: v.slice(0, CAP), truncated: true };
        return { ok: true, value: v };
      }
      // get-all: cap the cumulative payload (values can be large JSON blobs) and
      // report truncation rather than streaming megabytes over WS+stdio.
      const entries: Record<string, string> = {};
      let budget = CAP;
      let truncated = false;
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k == null) continue;
        const v = store.getItem(k) ?? "";
        if (budget - (k.length + v.length) < 0) {
          truncated = true;
          break;
        }
        budget -= k.length + v.length;
        entries[k] = v;
      }
      return truncated ? { ok: true, entries, truncated } : { ok: true, entries };
    }
    if (action === "set") {
      if (key == null) return { ok: false, error: "set requires a key" };
      store.setItem(key, value ?? "");
      return { ok: true };
    }
    if (action === "remove") {
      if (key == null) return { ok: false, error: "remove requires a key" };
      store.removeItem(key);
      return { ok: true };
    }
    if (action === "clear") {
      store.clear();
      return { ok: true };
    }
    return { ok: false, error: `unknown action: ${action}` };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}


/** get_accessibility_tree: a bounded hierarchical role/name/text outline of the
 *  VISIBLE DOM — structure to complement read_page's flat interactive refs.
 *  Caps at maxNodes + a depth limit and reports `truncated` (no silent cut).
 *  Self-contained (serialized to the page) — no module scope. */
export function axTreeInPage(
  maxNodes?: number | null,
): { ok: boolean; tree: unknown; nodes: number; truncated: boolean } {
  const LIMIT = Math.min(Math.max(maxNodes ?? 400, 1), 2000);
  const MAX_DEPTH = 20;
  let count = 0;
  let truncated = false;

  const visible = (el: Element): boolean => {
    const s = window.getComputedStyle(el as HTMLElement);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    const r = (el as HTMLElement).getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  };
  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return (el as HTMLAnchorElement).getAttribute("href") ? "link" : "generic";
    const map: Record<string, string> = {
      button: "button", h1: "heading", h2: "heading", h3: "heading", h4: "heading",
      h5: "heading", h6: "heading", img: "img", input: "textbox", textarea: "textbox",
      select: "combobox", nav: "navigation", main: "main", header: "banner",
      footer: "contentinfo", ul: "list", ol: "list", li: "listitem", table: "table",
      form: "form", section: "region", article: "article",
    };
    return map[tag] || "generic";
  };
  const nameOf = (el: Element): string => {
    const label =
      el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title");
    if (label) return label.trim().slice(0, 200);
    let t = "";
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === 3) t += n.textContent; // own text nodes only
    }
    return t.trim().slice(0, 200);
  };
  const walk = (el: Element, depth: number): Record<string, unknown> | null => {
    if (count >= LIMIT) {
      truncated = true;
      return null;
    }
    if (!visible(el)) return null;
    count++;
    const node: Record<string, unknown> = { role: roleOf(el) };
    const name = nameOf(el);
    if (name) node.name = name;
    if (depth < MAX_DEPTH) {
      const children: Record<string, unknown>[] = [];
      for (const child of Array.from(el.children)) {
        const c = walk(child, depth + 1);
        if (c) children.push(c);
      }
      if (children.length) node.children = children;
    } else if (el.children.length) {
      truncated = true; // depth cap dropped real children — report it (no silent cut)
    }
    return node;
  };

  const tree = document.body ? walk(document.body, 0) : null;
  return { ok: true, tree: tree ?? { role: "document" }, nodes: count, truncated };
}
