// Serialized by Chrome: each function must remain self-contained, including its inline resolver/predicates.
//
// DUPLICATED PREDICATES — change every copy together:
// - the ref resolver: the sync list is in the banner of injected-page-scripts.ts;
// - the point hit test (elementFromPoint, then down through open shadow roots):
//   pageInteract here, pointerTargetInPage in browser-pointer.ts and the
//   file_drop guard in browser-tools.ts;
// - the enabled test `matches(":disabled")` (a control inside <fieldset disabled>
//   is disabled, one in the fieldset's first <legend> is not):
//   sampleActionableInPage and pageInteract's type/key refusal here,
//   formInputInPage / fillFormInPage in injected-form-scripts.ts,
//   pointerTargetInPage in browser-pointer.ts, nodeOf / marked mode in
//   perception-scripts.ts, focusRef's editable test in computer-input.ts and
//   webElementScript in src/assistant-web.ts;
// - the key-chord parser: pageInteract here and keyEvent in computer-input.ts.

/** computer: pointer/keyboard interaction in the page. */
export function pageInteract(
  action: string,
  p: {
    ref?: string;
    coordinate?: [number, number];
    text?: string;
    scroll_direction?: string;
    scroll_amount?: number;
    start_coordinate?: [number, number];
    modifiers?: string;
    repeat?: number;
  },
): { ok: boolean; error?: string; info?: string; moved?: boolean; reason?: string } {
  try {
    // The deepest element at a viewport point, through open shadow roots: the
    // document alone answers with the shadow host, which ignores the event.
    const hitAt = (x: number, y: number): any => {
      let hit: any = document.elementFromPoint(x, y);
      while (hit?.shadowRoot) {
        const inner = hit.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === hit) break;
        hit = inner;
      }
      return hit;
    };
    // A synthetic event on a frame element never reaches the document inside it,
    // so a point over a frame is refused instead of reporting a click on the frame.
    const pointTarget = (x: number, y: number): any => {
      const el = hitAt(x, y);
      if (!el) throw new Error(`No element at (${x},${y})`);
      if (/^(IFRAME|FRAME)$/.test(String(el.tagName).toUpperCase())) {
        throw new Error(`(${x},${y}) is over a frame; a synthetic event cannot reach the page inside it. Act on the control's own frame ref (ref_N@frameId from read_page/find), or click this point with pointerMode:"browser".`);
      }
      return el;
    };
    const resolve = (): any => {
      if (p.ref) {
        const r = p.ref;
        if (!/^ref_\d+$/.test(r)) throw new Error(`invalid ref "${String(r).slice(0, 40)}"`);
        const resolveIssued = (r: string): any => {
          if (!/^ref_\d+$/.test(r)) throw new Error("invalid ref");
          const w = window as any;
          const state = w.__ccmcpRefState;
          if (state?.document !== document || !/^ref_\d{50}$/.test(r) || r.slice(4, 44) !== state.namespace)
            throw new Error(`Stale ref ${r}; read the page again`);
          const el = w.__ccmcpRefMap?.[r];
          if (!el?.isConnected || el.ownerDocument !== document || el.getAttribute("data-ccmcp-ref") !== r)
            throw new Error(`Stale ref ${r}; read the page again`);
          let matches = 0;
          const visit = (root: any): void => {
            for (const candidate of root.querySelectorAll(`[data-ccmcp-ref="${r}"]`)) {
              if (candidate.isConnected && candidate.ownerDocument === document) {
                if (candidate !== el || ++matches > 1) throw new Error(`Ambiguous ref ${r}; read the page again`);
              }
            }
            for (const node of root.querySelectorAll("*")) if (node.shadowRoot) visit(node.shadowRoot);
          };
          visit(document);
          if (matches !== 1) throw new Error(`Stale ref ${r}; read the page again`);
          return el;
        };
        return resolveIssued(r);
      }
      if (p.coordinate) return pointTarget(p.coordinate[0], p.coordinate[1]);
      return null;
    };
    // Modifier names are case-insensitive: "Ctrl", "SHIFT", "cmd" all count.
    const modsOf = (spec: string) => {
      const m = (spec || "").toLowerCase();
      return {
        ctrlKey: /\b(ctrl|control)\b/.test(m),
        shiftKey: /\bshift\b/.test(m),
        altKey: /\b(alt|option)\b/.test(m),
        metaKey: /\b(cmd|meta|win|command)\b/.test(m),
      };
    };
    const mods = () => modsOf(p.modifiers || "");
    // Key chord parser (duplicated on the CDP path in browser-tools.ts — keep in
    // sync): "ctrl+a" / "shift+Tab" / "cmd+shift+z"; a trailing "+" is the key
    // itself ("shift++"). Chord modifiers merge with `modifiers`.
    const chord = (token: string) => {
      const parts = token.split("+");
      let key = parts.pop() ?? token;
      if (key === "" && parts.length) {
        parts.pop();
        key = "+";
      }
      const base = mods();
      const extra = modsOf(parts.join("+"));
      return {
        key,
        mods: {
          ctrlKey: base.ctrlKey || extra.ctrlKey,
          shiftKey: base.shiftKey || extra.shiftKey,
          altKey: base.altKey || extra.altKey,
          metaKey: base.metaKey || extra.metaKey,
        },
      };
    };
    // Same vocabulary as the CDP path: single characters plus these names.
    const KEY_NAMES = /^(Enter|Tab|Backspace|Escape|Delete|Insert|Space|Home|End|PageUp|PageDown|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|F([1-9]|1[0-2])|Shift|Control|Alt|Meta)$/;
    const centerOf = (el: any): [number, number] => {
      const r = el.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    };
    const mouse = (el: any, x: number, y: number, types: string[]) => {
      for (const t of types)
        el.dispatchEvent(
          new MouseEvent(t, {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            view: window,
            ...mods(),
          }),
        );
    };

    switch (action) {
      case "left_click": {
        const el = resolve();
        if (!el) throw new Error("left_click needs ref or coordinate");
        // A coordinate names a point of the page as it is now, often read off a
        // screenshot; scrolling would move every later point from that view.
        if (p.ref) el.scrollIntoView({ block: "center", inline: "center" });
        const [x, y] = p.coordinate || centerOf(el);
        mouse(el, x, y, ["mousemove", "mousedown", "mouseup"]);
        // Chrome scrolls a focused element that is not fully in view; a
        // coordinate target is focused where it is.
        if (typeof el.focus === "function") el.focus({ preventScroll: !p.ref });
        el.click();
        return { ok: true, info: `clicked ${el.tagName.toLowerCase()}` };
      }
      case "right_click": {
        const el = resolve();
        if (!el) throw new Error("right_click needs ref or coordinate");
        const [x, y] = p.coordinate || centerOf(el);
        mouse(el, x, y, ["mousedown", "mouseup", "contextmenu"]);
        return { ok: true, info: "right-clicked" };
      }
      case "double_click": {
        const el = resolve();
        if (!el) throw new Error("double_click needs ref or coordinate");
        const [x, y] = p.coordinate || centerOf(el);
        mouse(el, x, y, [
          "mousedown",
          "mouseup",
          "click",
          "mousedown",
          "mouseup",
          "click",
          "dblclick",
        ]);
        return { ok: true, info: "double-clicked" };
      }
      case "triple_click": {
        const el = resolve();
        if (!el) throw new Error("triple_click needs ref or coordinate");
        const [x, y] = p.coordinate || centerOf(el);
        mouse(el, x, y, ["click", "click", "click"]);
        const tag = String(el.tagName || "").toLowerCase();
        if ((tag === "input" || tag === "textarea") && typeof el.select === "function") {
          // A text control's contents are not DOM text nodes (firstChild is
          // null) — select() is the real "select all" for it. A coordinate
          // target is focused where it is, as in left_click; select() then
          // finds it focused and does not scroll either.
          if (typeof el.focus === "function") el.focus({ preventScroll: !p.ref });
          el.select();
          return { ok: true, info: "triple-clicked (field text selected)" };
        }
        const sel = window.getSelection?.();
        if (sel && el.firstChild) {
          const range = document.createRange();
          range.selectNodeContents(el);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        return { ok: true, info: "triple-clicked" };
      }
      case "hover": {
        const el = resolve();
        if (!el) throw new Error("hover needs ref or coordinate");
        const [x, y] = p.coordinate || centerOf(el);
        mouse(el, x, y, ["mouseover", "mouseenter", "mousemove"]);
        return { ok: true, info: "hovered" };
      }
      case "type": {
        if (typeof p.text !== "string")
          throw new Error("type needs text");
        let el: any;
        if (p.ref) {
          // The named field, not whatever happens to hold focus in this frame.
          // A control that cannot take input is refused before it is focused:
          // the value setter below would write into it and fire `input`.
          el = resolve();
          if (el.matches(":disabled")) throw new Error("the ref is a disabled field; nothing was typed");
          if (el.readOnly === true) throw new Error("the ref is a read-only field; nothing was typed");
          if (typeof el.focus === "function") el.focus();
        } else {
          // Descend through shadow hosts to the really-focused element.
          el = document.activeElement;
          while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
        }
        const tag = el?.tagName?.toLowerCase();
        if (el && (tag === "input" || tag === "textarea")) {
          const proto =
            tag === "textarea"
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          const next = (el.value || "") + p.text;
          if (setter) setter.call(el, next);
          else el.value = next;
          el.dispatchEvent(new Event("input", { bubbles: true }));
        } else if (el && el.isContentEditable) {
          el.textContent = (el.textContent || "") + p.text;
          el.dispatchEvent(new Event("input", { bubbles: true }));
        } else {
          throw new Error(p.ref ? "the ref is not an editable field; nothing was typed" : "no focused editable element — click the field first");
        }
        return { ok: true, info: `typed ${p.text.length} chars` };
      }
      case "key": {
        if (typeof p.text !== "string") throw new Error("key needs text");
        // Clamped here too: the schema cap does not reach a raw/batch caller.
        const times = Math.min(200, Math.max(1, Math.floor(p.repeat || 1)));
        const tokens = p.text.split(/\s+/).filter(Boolean);
        for (const t of tokens) {
          const { key } = chord(t);
          if (key.length !== 1 && !KEY_NAMES.test(key)) {
            throw new Error(`unknown key name "${key}" — use a single character or Enter/Tab/Escape/Backspace/Delete/Space/Home/End/PageUp/PageDown/Insert/Arrow*/F1-F12`);
          }
        }
        // Only a fully valid sequence may move focus to a named element.
        let el: any = document.activeElement || document.body;
        if (p.ref) {
          el = resolve();
          // A disabled control takes no keys, and Enter must not submit its form.
          if (el.matches(":disabled")) throw new Error("the ref is a disabled control; no key was pressed");
          if (typeof el.focus === "function") el.focus();
        }
        for (let i = 0; i < times; i++) {
          for (const t of tokens) {
            const c = chord(t);
            const key = c.key === "Space" ? " " : c.key;
            const init = { bubbles: true, cancelable: true, key, ...c.mods };
            el.dispatchEvent(new KeyboardEvent("keydown", init));
            el.dispatchEvent(new KeyboardEvent("keyup", init));
            // Synthetic key events don't trigger defaults; special-case Enter —
            // but a textarea / contenteditable inserts a newline, it never submits.
            if (key === "Enter" && !c.mods.ctrlKey && !c.mods.metaKey) {
              const tag = String(el.tagName || "").toLowerCase();
              if (tag !== "textarea" && !el.isContentEditable) {
                const form = el.form || el.closest?.("form");
                if (form && typeof form.requestSubmit === "function")
                  form.requestSubmit();
              }
            }
          }
        }
        return { ok: true, info: `pressed ${p.text}` };
      }
      case "scroll": {
        const dir = p.scroll_direction || "down";
        const amount = (p.scroll_amount || 3) * 100;
        const dx = dir === "right" ? amount : dir === "left" ? -amount : 0;
        const dy = dir === "down" ? amount : dir === "up" ? -amount : 0;
        const vertical = dy !== 0;
        // Start where a wheel would act: the target, else the element at the
        // viewport centre (apps scroll an inner container, not the window).
        // A point over a frame, or outside the viewport, still scrolls what is around
        // it: unlike a click, a scroll is never an error.
        const start: any = p.ref ? resolve()
          : p.coordinate ? hitAt(p.coordinate[0], p.coordinate[1]) : hitAt(innerWidth / 2, innerHeight / 2);
        const root = document.documentElement;
        const rootStyle = getComputedStyle(root);
        // While the root's overflow is visible, body's overflow belongs to the viewport.
        const bodyIsViewport = rootStyle.overflowX === "visible" && rootStyle.overflowY === "visible";
        const scrollsOnAxis = (el: any): boolean => {
          if (el === root || el === document.scrollingElement || (el === document.body && bodyIsViewport)) return false;
          const style = getComputedStyle(el);
          return /^(auto|scroll|overlay)$/.test(vertical ? style.overflowY : style.overflowX) &&
            (vertical ? el.scrollHeight > el.clientHeight : el.scrollWidth > el.clientWidth);
        };
        // Flat-tree parent: a slotted node scrolls with its slot, a shadow tree with its host.
        const parentOf = (el: any): any => el.assignedSlot || el.parentElement || el.parentNode?.host || null;
        const nameOf = (el: any): string => `${String(el.tagName).toLowerCase()}${el.id ? `#${el.id}` : ""}`;
        // The nearest container that still moves in this direction takes the
        // scroll; one already at its end hands it on, ending at the window, as a
        // wheel does. A ref names what to scroll, so its own container at its end
        // is the answer and the page behind a list or a dialog stays where it is.
        // Trying is the test: a scrollBy that cannot move changes nothing.
        // "instant": a page with smooth scrolling has otherwise not moved yet
        // when the position is read back.
        let atEnd: any = null;
        for (let el = start; el && el !== root; el = parentOf(el)) {
          if (!scrollsOnAxis(el)) continue;
          const before = [el.scrollLeft, el.scrollTop];
          el.scrollBy({ left: dx, top: dy, behavior: "instant" });
          if (el.scrollLeft !== before[0] || el.scrollTop !== before[1]) return { ok: true, moved: true, info: `scrolled ${dir} (${nameOf(el)})` };
          atEnd ??= el;
          if (p.ref) return { ok: true, moved: false, reason: `${nameOf(el)} is already at its end in that direction`, info: `did not scroll ${dir}` };
        }
        const before = [window.scrollX, window.scrollY];
        window.scrollBy({ left: dx, top: dy, behavior: "instant" });
        if (window.scrollX !== before[0] || window.scrollY !== before[1]) return { ok: true, moved: true, info: `scrolled ${dir} (page)` };
        // Not moving is an honest result, never an error: a recipe may scroll past the end.
        const page: any = document.scrollingElement || root;
        const pageScrolls = vertical ? page.scrollHeight > page.clientHeight : page.scrollWidth > page.clientWidth;
        const reason = atEnd && pageScrolls ? `${nameOf(atEnd)} and the page are already at their end in that direction`
          : atEnd ? `${nameOf(atEnd)} is already at its end in that direction`
          : pageScrolls ? "the page is already at its end in that direction"
          : `nothing at this point can scroll ${vertical ? "vertically" : "horizontally"}`;
        return { ok: true, moved: false, reason, info: `did not scroll ${dir}` };
      }
      case "scroll_to": {
        const el = resolve();
        if (!el) throw new Error("scroll_to needs ref");
        el.scrollIntoView({ block: "center", inline: "center" });
        return { ok: true, info: "scrolled into view" };
      }
      case "left_click_drag": {
        if (!p.start_coordinate || !p.coordinate)
          throw new Error("left_click_drag needs start_coordinate + coordinate");
        const [sx, sy] = p.start_coordinate;
        const [ex, ey] = p.coordinate;
        const startEl = pointTarget(sx, sy);
        const endEl = pointTarget(ex, ey);
        mouse(startEl, sx, sy, ["mousemove", "mousedown"]);
        mouse(startEl, ex, ey, ["mousemove"]);
        mouse(endEl, ex, ey, ["mousemove", "mouseup"]);
        return { ok: true, info: "dragged" };
      }
      default:
        throw new Error(`Unsupported computer action: ${action}`);
    }
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}


/**
 * Actionability gate: resolve once the ref'd element is present, visible,
 * enabled, and geometrically stable (same rect twice in a row) — or time out.
 * executeScript awaits this promise. Runs in the world where refs are tagged.
 */
export function sampleActionableInPage(
  ref: string,
): { ok: boolean; rect?: { x: number; y: number; w: number; h: number }; reason?: string; fatal?: string } {
  const resolveRef = (r: string): any => {
    if (!/^ref_\d+$/.test(r)) throw new Error("invalid ref");
    const w = window as any;
    const state = w.__ccmcpRefState;
    if (state?.document !== document || !/^ref_\d{50}$/.test(r) || r.slice(4, 44) !== state.namespace)
      throw new Error(`Stale ref ${r}; read the page again`);
    const el = w.__ccmcpRefMap?.[r];
    if (!el?.isConnected || el.ownerDocument !== document || el.getAttribute("data-ccmcp-ref") !== r)
      throw new Error(`Stale ref ${r}; read the page again`);
    let matches = 0;
    const visit = (root: any): void => {
      for (const candidate of root.querySelectorAll(`[data-ccmcp-ref="${r}"]`)) {
        if (candidate.isConnected && candidate.ownerDocument === document) {
          if (candidate !== el || ++matches > 1) throw new Error(`Ambiguous ref ${r}; read the page again`);
        }
      }
      for (const node of root.querySelectorAll("*")) if (node.shadowRoot) visit(node.shadowRoot);
    };
    visit(document);
    if (matches !== 1) throw new Error(`Stale ref ${r}; read the page again`);
    return el;
  };
  let el: any;
  try { el = resolveRef(ref); }
  catch (error) {
    return { ok: false, fatal: String((error as Error)?.message ?? error) };
  }
  const st = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const visible = st.display !== "none" && st.visibility !== "hidden" && r.width > 0 && r.height > 0;
  // `:disabled`, not the property: a control in a disabled fieldset reports disabled=false.
  const enabled = !el.matches(":disabled") && el.getAttribute("aria-disabled") !== "true";
  return {
    ok: visible && enabled,
    rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    ...(!visible ? { reason: "not visible" } : !enabled ? { reason: "disabled" } : {}),
  };
}
