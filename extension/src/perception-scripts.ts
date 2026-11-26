// Injected with func.toString(): this entry point and every helper it uses must
// stay self-contained. Semantic names/roles deliberately use Tabai's small
// pageQuery model, not a full ARIA accessible-name engine. Refs share pageQuery's
// document identity, clone protection and monotonic counter; they never cross a frame boundary.
//
// DUPLICATED PREDICATES — change every copy together (sync lists in the banners
// of injected-page-scripts.ts and injected-interaction-scripts.ts):
// - `secret`, with `isSecretField` in pageQuery, formInputInPage and fillFormInPage
//   (and its autocomplete-token rule in src/assistant-web.ts);
// - the walk bounds (depth 512, 20 000 elements), with pageQuery;
// - names bounded to 500 characters, with pageQuery's accName; text() never reads
//   a textarea's text, with pageQuery's boundedText, and both read label,
//   label[for] and aria-labelledby names;
// - the enabled test `:disabled`, with sampleActionableInPage, pageInteract,
//   formInputInPage, fillFormInPage, pointerTargetInPage, focusRef in
//   computer-input.ts and webElementScript in src/assistant-web.ts.
export type PerceptionOptions = {
  mode: "identity" | "resolve" | "describe" | "table" | "scan" | "marked";
  describeRef?: string;
  selector?: string;
  role?: string;
  name?: string;
  mint?: boolean;
  filter?: "interactive" | "all";
  maxResults?: number;
  maxRows?: number;
  maxColumns?: number;
};
export type PerceptionRect = { x: number; y: number; width: number; height: number };
export type PageNode = {
  ref: string;
  role: string;
  name: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  rect?: PerceptionRect;
};
export type PagePerception = {
  viewport: { scrollX: number; scrollY: number; width: number; height: number; dpr: number;
    visualX: number; visualY: number; visualWidth: number; visualHeight: number; scale: number };
  nodes: PageNode[];
  matches: { role: string; name: string; ref?: string }[];
  matchCount: number;
  truncated: boolean;
  iframeCount: number;
  scrollPositions?: number[][];
  recordingTarget?: { candidates: Array<{ selector: string } | { role: string; name: string }>;
    fieldSelectors: string[]; sensitive: boolean; fieldType?: 'string' | 'boolean' | 'selection'; role: string; name: string };
  table?: { columns: string[]; rows: string[][]; truncated: boolean; rowLimit: number;
    columnLimit: number; sourceRows: number; sourceCells: number; headers: boolean };
};

export function perceiveInPage(options: PerceptionOptions): PagePerception {
  const vv = window.visualViewport;
  const result: PagePerception = {
    viewport: { scrollX: window.scrollX, scrollY: window.scrollY, width: window.innerWidth,
      height: window.innerHeight, dpr: window.devicePixelRatio, visualX: vv?.offsetLeft ?? 0,
      visualY: vv?.offsetTop ?? 0, visualWidth: vv?.width ?? window.innerWidth,
      visualHeight: vv?.height ?? window.innerHeight, scale: vv?.scale ?? 1 },
    nodes: [], matches: [], matchCount: 0, truncated: false, iframeCount: 0,
  };
  if (options.mode === "identity") return result;
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
  const refs = w.__ccmcpRefMap;
  // Removed/adopted nodes never transfer their identity to a cloned attribute.
  for (const ref of Object.keys(refs)) {
    if (!refs[ref]?.isConnected || refs[ref].ownerDocument !== document) delete refs[ref];
  }
  const refOf = (el: Element): string => {
    let ref = el.getAttribute("data-ccmcp-ref");
    // Loop prevention observes the page before dispatch. It must not mint refs
    // or repair cloned attributes, because doing so could authorize the action
    // it is supposed to inspect. Explicit perception/read calls still mint.
    if (options.mint === false) {
      return ref && /^ref_\d{50}$/.test(ref) && ref.slice(4, 44) === namespace && refs[ref] === el ? ref : "";
    }
    if (!ref || !/^ref_\d{50}$/.test(ref) || ref.slice(4, 44) !== namespace || refs[ref] !== el) {
      if (w.__ccmcpRef >= 9_999_999_999) throw new Error("Reference counter exhausted; reload the page");
      ref = `ref_${namespace}${String(++w.__ccmcpRef).padStart(10, "0")}`;
      el.setAttribute("data-ccmcp-ref", ref);
    }
    refs[ref] = el;
    return ref;
  };
  const parentOf = (el: Element): Element | null =>
    el.parentElement || (el.getRootNode() instanceof ShadowRoot ? (el.getRootNode() as ShadowRoot).host : null);
  const visible = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    for (let p: Element | null = el; p; p = parentOf(p)) {
      if (p.matches('[aria-hidden="true"],[inert],[hidden]')) return false;
      const style = getComputedStyle(p);
      if (style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
    }
    return true;
  };
  const text = (el: Element, max = 200): string => {
    if (el.matches("input,textarea,select")) return "";
    let out = "";
    let visited = 0;
    const visit = (node: Node, depth: number) => {
      if (depth > 3 || visited++ > 200 || out.length >= max) return;
      for (const child of node.childNodes) {
        if (out.length >= max) break;
        if (child.nodeType === Node.TEXT_NODE) out += child.textContent;
        else if (child instanceof Element && child.childElementCount <= 50 &&
          !child.matches("script,style,noscript,template,input,textarea,select,table")) visit(child, depth + 1);
      }
    };
    if (el.childElementCount <= 50) visit(el, 0);
    return out.replace(/\s+/g, " ").trim().slice(0, max);
  };
  const nameOf = (el: Element): string => {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim().slice(0, 500);
    const root = el.getRootNode() as Document | ShadowRoot;
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const name = labelledby.split(/\s+/).map(id => { const label = root.getElementById(id); return label ? text(label, 500) : ""; }).join(" ").trim();
      if (name) return name.slice(0, 500);
    }
    if (el.matches("input,textarea")) {
      const label = el.id ? root.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
      if (label && text(label, 500)) return text(label, 500);
      const wrapped = el.closest("label");
      if (wrapped && text(wrapped, 500)) return text(wrapped, 500);
      if (el.getAttribute("placeholder")) return el.getAttribute("placeholder")!.slice(0, 500);
      if (el.getAttribute("name")) return el.getAttribute("name")!.slice(0, 500);
    }
    if (el.matches("img") && el.getAttribute("alt")) return el.getAttribute("alt")!.slice(0, 500);
    if (el.getAttribute("title")) return el.getAttribute("title")!.slice(0, 500);
    return secret(el) ? "" : text(el).slice(0, 120);
  };
  const roleOf = (el: Element): string => {
    if (el.getAttribute("role")) return el.getAttribute("role")!;
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") return type;
      return ["button", "submit", "reset", "image"].includes(type) ? "button" : "textbox";
    }
    const roles: Record<string, string> = { a: "link", button: "button", select: "combobox", textarea: "textbox",
      img: "img", nav: "navigation", main: "main", header: "banner", footer: "contentinfo",
      h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading" };
    return roles[tag] || tag;
  };
  const interactive = (el: Element): boolean => el.matches("a,button,input,select,textarea,[onclick]") ||
    ["button", "link", "checkbox", "radio", "menuitem", "tab", "switch", "combobox", "option"].includes(el.getAttribute("role") || "") ||
    (el.hasAttribute("tabindex") && Number(el.getAttribute("tabindex")) >= 0) || (el as HTMLElement).isContentEditable;
  const secret = (el: Element): boolean => {
    if (!el.matches("input,textarea")) return false;
    const type = (el.getAttribute("type") || "text").toLowerCase();
    const ac = (el.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/);
    return type === "password" || type === "hidden" ||
      ac.some(token => ["current-password", "new-password", "one-time-code"].includes(token) || token.startsWith("cc-")) ||
      /pass|otp|cvv|cvc/i.test((el.getAttribute("name") || "") + " " + el.id);
  };
  const nodeOf = (el: Element, includeRect = false): PageNode => {
    const node: PageNode = { ref: refOf(el), role: roleOf(el), name: nameOf(el) };
    const raw = (el as HTMLInputElement).value;
    if (raw !== undefined && raw !== "" && node.role !== "button") node.value = secret(el) ? "•••" : String(raw).slice(0, 500);
    if (el.matches('input[type="checkbox"],input[type="radio"]')) node.checked = (el as HTMLInputElement).checked;
    else if (el.hasAttribute("aria-checked")) node.checked = el.getAttribute("aria-checked") === "true";
    if (el.matches(":disabled,[aria-disabled=true]")) node.disabled = true;
    if (includeRect) {
      const r = el.getBoundingClientRect();
      node.rect = { x: r.x, y: r.y, width: r.width, height: r.height };
    }
    return node;
  };
  // Bound source traversal separately from output limits: a huge/hostile DOM
  // cannot turn one small request into an unbounded worker operation.
  const elements: Element[] = [];
  const walk = (root: ParentNode, depth: number): void => {
    // Real pages nest past 60 (Gmail's reply box reaches 67); 512 is where Chromium's own HTML parser stops nesting.
    if (depth > 512) { result.truncated = true; return; }
    for (const el of root.children) {
      if (elements.length >= 20_000) { result.truncated = true; return; }
      elements.push(el);
      if (el.matches("iframe,frame")) result.iframeCount++;
      if (el.matches("script,style,noscript,template")) continue;
      walk(el, depth + 1);
      if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
    }
  };
  walk(document, 0);
  if (options.mode === "describe") {
    const ref = options.describeRef ?? '', el = refs[ref] as Element | undefined;
    if (result.truncated || !/^ref_\d{50}$/.test(ref) || ref.slice(4, 44) !== namespace ||
      !el?.isConnected || el.ownerDocument !== document || el.getAttribute('data-ccmcp-ref') !== ref ||
      elements.filter(candidate => candidate.getAttribute('data-ccmcp-ref') === ref).length !== 1 || !visible(el)) {
      throw new Error('The recording target is stale, duplicated, hidden or unavailable.');
    }
    const candidates: Array<{ selector: string } | { role: string; name: string }> = [];
    const fieldSelectors: string[] = [];
    for (const attribute of ['id', 'data-testid', 'data-test', 'name']) {
      const value: string | null = el.getAttribute(attribute);
      if (!value || value.length > 200 || /data-ccmcp-ref|ref_\d{50}/.test(value)) continue;
      const selector: string = attribute === 'id' ? `#${CSS.escape(value)}` : `${el.tagName.toLowerCase()}[${attribute}="${CSS.escape(value)}"]`;
      const matches: Element[] = elements.filter(candidate => candidate.matches(selector) && visible(candidate));
      if (matches.length !== 1 || matches[0] !== el) continue;
      candidates.push({ selector });
      const fields: NodeListOf<Element> = document.querySelectorAll(selector);
      if (fields.length === 1 && fields[0] === el && el.matches('input,textarea,select')) fieldSelectors.push(selector);
    }
    const role = roleOf(el), name = nameOf(el);
    if (name && elements.filter(candidate => visible(candidate) && roleOf(candidate) === role && nameOf(candidate) === name).length === 1) candidates.push({ role, name });
    result.recordingTarget = { candidates, fieldSelectors, sensitive: secret(el), role, name,
      ...(el.matches('input,textarea,select') ? { fieldType: el.matches('select') ? 'selection' : el.matches('input[type="checkbox"],input[type="radio"]') ? 'boolean' : 'string' } : {}) };
    return result;
  }
  if (options.mode === "resolve") {
    if (options.selector) document.querySelector(options.selector); // reject invalid CSS even on empty documents
    for (const el of elements) {
      const matches = options.selector ? el.matches(options.selector) : roleOf(el) === options.role && nameOf(el) === options.name;
      if (!matches || !visible(el)) continue;
      result.matchCount++;
      if (result.matches.length < 10) {
        const ref = el.getAttribute("data-ccmcp-ref");
        result.matches.push({ role: roleOf(el), name: nameOf(el), ...(ref && refs[ref] === el ? { ref } : {}) });
      }
    }
    if (options.mint && result.matchCount === 1 && !result.truncated) {
      const el = elements.find(el => visible(el) && (options.selector ? el.matches(options.selector) : roleOf(el) === options.role && nameOf(el) === options.name))!;
      result.nodes = [nodeOf(el)];
    }
    return result;
  }
  if (options.mode === "table") {
    const tableSelector = 'table,[role="table"],[role="grid"],[role="treegrid"]';
    const tableOwner = (el: Element): Element | null => {
      for (let p: Element | null = el; p; p = parentOf(p)) if (p.matches(tableSelector)) return p;
      return null;
    };
    if (options.selector) document.querySelector(options.selector);
    const tables = elements.filter(el => el.matches(options.selector || tableSelector) && visible(el));
    if (tables.some(el => !el.matches(tableSelector))) throw new Error("extract_table selector must identify a native or ARIA table/grid");
    result.matchCount = tables.length;
    result.matches = tables.slice(0, 10).map(el => ({ role: roleOf(el), name: nameOf(el) }));
    if (tables.length !== 1 || !options.mint) return result;
    const table = tables[0];
    const maxRows = Math.max(1, Math.min(1000, options.maxRows || 100));
    const maxColumns = Math.max(1, Math.min(100, options.maxColumns || 30));
    const rows = elements.filter(el => el.matches('tr,[role="row"]') && tableOwner(el) === table && visible(el));
    const cellsByRow = new Map<Element, Element[]>();
    for (const cell of elements) {
      if (!cell.matches('th,td,[role="cell"],[role="gridcell"],[role="columnheader"],[role="rowheader"]') || tableOwner(cell) !== table || !visible(cell)) continue;
      for (let p = parentOf(cell); p && p !== table; p = parentOf(p)) {
        if (!p.matches('tr,[role="row"]')) continue;
        const cells = cellsByRow.get(p) || [];
        cells.push(cell);
        cellsByRow.set(p, cells);
        break;
      }
    }
    const matrix: string[][] = [];
    let cellsRead = 0;
    let chars = 0;
    let headers = false;
    let cut = result.truncated;
    const rowLimit = maxRows + 1; // at most one extra source row for the header
    for (let r = 0; r < Math.min(rows.length, rowLimit); r++) {
      const row = rows[r];
      const cells = cellsByRow.get(row) || [];
      if (r === 0) headers = cells.length > 0 && cells.every(el => el.matches('th,[role="columnheader"]'));
      if (r >= maxRows + (headers ? 1 : 0)) { cut = true; break; }
      matrix[r] ||= [];
      let c = 0;
      for (const cell of cells) {
        if (++cellsRead > 10_000 || chars >= 80_000) { cut = true; break; }
        const colRaw = Number(cell.getAttribute("colspan") || cell.getAttribute("aria-colspan") || 1);
        const rowRaw = Number(cell.getAttribute("rowspan") ?? cell.getAttribute("aria-rowspan") ?? 1);
        const cols = Number.isFinite(colRaw) ? Math.max(1, Math.floor(colRaw)) : 1;
        const rowGroup = row.parentElement;
        const groupEnd = rowRaw === 0 ? rows.findIndex((candidate, index) => index > r && candidate.parentElement !== rowGroup) : -1;
        const rowSpan = rowRaw === 0 ? (groupEnd < 0 ? rows.length : groupEnd) - r : Number.isFinite(rowRaw) ? Math.max(1, Math.floor(rowRaw)) : 1;
        // Skip occupied ranges, not only the first slot, so overlapping spans
        // never overwrite text previously assigned by a rowspan.
        while (c < maxColumns && Array.from({ length: Math.min(cols, maxColumns - c) }, (_, i) => matrix[r][c + i]).some(value => value !== undefined)) c++;
        if (c >= maxColumns) { cut = true; break; }
        if (c + cols > maxColumns || r + rowSpan > maxRows + (headers ? 1 : 0)) cut = true;
        const value = text(cell, 1000).slice(0, Math.max(0, 80_000 - chars));
        for (let rr = r; rr < Math.min(r + rowSpan, rows.length, maxRows + (headers ? 1 : 0)); rr++) {
          matrix[rr] ||= [];
          for (let cc = c; cc < Math.min(c + cols, maxColumns); cc++) {
            if (matrix[rr][cc] !== undefined) throw new Error("table has overlapping row/column spans");
            const boundedValue = value.slice(0, Math.max(0, 80_000 - chars));
            if (boundedValue.length < value.length) cut = true;
            matrix[rr][cc] = boundedValue;
            chars += boundedValue.length;
          }
        }
        c += cols;
      }
      if (cellsRead > 10_000 || chars >= 80_000) break;
    }
    if (rows.length > maxRows + (headers ? 1 : 0)) cut = true;
    const width = Math.min(maxColumns, Math.max(0, ...matrix.map(row => row.length)));
    const rectangular = matrix.map(row => Array.from({ length: width }, (_, c) => row[c] ?? ""));
    const columns = headers ? rectangular.shift()! : Array.from({ length: width }, (_, c) => `Column ${c + 1}`);
    result.table = { columns, rows: rectangular, truncated: cut, rowLimit: maxRows, columnLimit: maxColumns,
      sourceRows: rows.length, sourceCells: cellsRead, headers };
    result.nodes = [nodeOf(table)];
    return result;
  }
  if (options.mode === "scan") {
    result.scrollPositions = [];
    for (let index = 0; index < elements.length; index++) {
      const el = elements[index];
      if (el.scrollLeft || el.scrollTop) {
        if (result.scrollPositions.length >= 500) { result.truncated = true; break; }
        result.scrollPositions.push([index, el.scrollLeft, el.scrollTop]);
      }
    }
  }
  const candidates: { el: Element; priority: number }[] = [];
  for (const el of elements) {
    const isInteractive = interactive(el);
    if (options.mode === "marked" && (!isInteractive || el.matches(':disabled,[aria-disabled="true"]'))) continue;
    if (options.filter === "interactive" && !isInteractive) continue;
    if (!visible(el)) continue;
    if (options.mode === "marked") {
      const r = el.getBoundingClientRect();
      if (r.right <= result.viewport.visualX || r.bottom <= result.viewport.visualY ||
        r.left >= result.viewport.visualX + result.viewport.visualWidth || r.top >= result.viewport.visualY + result.viewport.visualHeight) continue;
    } else if (!isInteractive) {
      // Structural wrappers duplicate their descendants. Retain text leaves,
      // headings, and explicit status/alert content; the refs still support action.
      const meaningful = el.matches('h1,h2,h3,h4,h5,h6,p,li,dt,dd,td,th,figcaption,[role="status"],[role="alert"],[role="heading"]') ||
        (el.childElementCount === 0 && !!text(el));
      if (!meaningful || !nameOf(el)) continue;
      if (el.parentElement?.closest("button,a,select,textarea")) continue;
    }
    let inMain = false;
    for (let p: Element | null = el; p; p = parentOf(p)) if (p.matches('main,[role="main"]')) { inMain = true; break; }
    candidates.push({ el, priority: (isInteractive ? 4 : 0) + (inMain ? 2 : 0) + (roleOf(el) === "heading" ? 1 : 0) });
  }
  if (options.mode !== "marked") candidates.sort((a, b) => b.priority - a.priority);
  const max = Math.max(1, Math.min(500, options.maxResults || 200));
  result.matchCount = candidates.length;
  result.truncated ||= candidates.length > max;
  result.nodes = candidates.slice(0, max).map(({ el }) => nodeOf(el, options.mode === "marked"));
  return result;
}
