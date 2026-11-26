import { cdpSend } from "./cdp";
import { NoFallbackError } from "./tool-error";
import { parseRef, deepByAttrExpr, evaluateRefInTab } from "./element-ref";
// Trusted pointer/keyboard input via CDP (isTrusted events native widgets honor).
//
// Key table modelled on Puppeteer's US layout: every key sends `key`, `code`
// and the Windows virtual key code (mirrored to nativeVirtualKeyCode) — Chrome
// resolves editing / scrolling / refresh defaults from the virtual key code, so
// a name without one (the old 8-entry table's fallback) dispatched keyCode 0 and
// silently did nothing. `text` (what a keypress inserts) is set only when no
// modifier other than Shift is held, as a real keyboard does.
const KEY_TABLE: Record<string, { key?: string; code: string; vk: number; text?: string }> = {
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Tab: { code: "Tab", vk: 9 },
  Backspace: { code: "Backspace", vk: 8 },
  Escape: { code: "Escape", vk: 27 },
  Delete: { code: "Delete", vk: 46 },
  Insert: { code: "Insert", vk: 45 },
  Space: { key: " ", code: "Space", vk: 32, text: " " },
  Home: { code: "Home", vk: 36 },
  End: { code: "End", vk: 35 },
  PageUp: { code: "PageUp", vk: 33 },
  PageDown: { code: "PageDown", vk: 34 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
  Shift: { code: "ShiftLeft", vk: 16 },
  Control: { code: "ControlLeft", vk: 17 },
  Alt: { code: "AltLeft", vk: 18 },
  Meta: { code: "MetaLeft", vk: 91 },
};
for (let i = 1; i <= 12; i++) KEY_TABLE[`F${i}`] = { code: `F${i}`, vk: 111 + i };
// US-layout punctuation → Windows VK (Puppeteer's table); shifted symbols share
// the unshifted key's code and VK.
const PUNCT_VK: Record<string, [string, number]> = {
  ";": ["Semicolon", 186], ":": ["Semicolon", 186], "=": ["Equal", 187], "+": ["Equal", 187],
  ",": ["Comma", 188], "<": ["Comma", 188], "-": ["Minus", 189], _: ["Minus", 189],
  ".": ["Period", 190], ">": ["Period", 190], "/": ["Slash", 191], "?": ["Slash", 191],
  "`": ["Backquote", 192], "~": ["Backquote", 192], "[": ["BracketLeft", 219], "{": ["BracketLeft", 219],
  "\\": ["Backslash", 220], "|": ["Backslash", 220], "]": ["BracketRight", 221], "}": ["BracketRight", 221],
  "'": ["Quote", 222], '"': ["Quote", 222],
  "!": ["Digit1", 49], "@": ["Digit2", 50], "#": ["Digit3", 51], $: ["Digit4", 52], "%": ["Digit5", 53],
  "^": ["Digit6", 54], "&": ["Digit7", 55], "*": ["Digit8", 56], "(": ["Digit9", 57], ")": ["Digit0", 48],
};
// CDP Input.dispatchKeyEvent modifier bitmask.
const MOD_ALT = 1;
const MOD_CTRL = 2;
const MOD_META = 4;
const MOD_SHIFT = 8;

function modifierMask(spec: string): number {
  const m = (spec || "").toLowerCase();
  let mask = 0;
  if (/\b(ctrl|control)\b/.test(m)) mask |= MOD_CTRL;
  if (/\bshift\b/.test(m)) mask |= MOD_SHIFT;
  if (/\b(alt|option)\b/.test(m)) mask |= MOD_ALT;
  if (/\b(cmd|meta|win|command)\b/.test(m)) mask |= MOD_META;
  return mask;
}

/** Parse one token of `key` text — "a", "Enter", "ctrl+a", "shift+Tab",
 *  "shift++" (a trailing "+" is the key) — into a CDP key event body. Kept in
 *  sync with the synthetic path's parser in injected-interaction-scripts.ts. */
function keyEvent(token: string, baseModifiers: number): Record<string, unknown> {
  const parts = token.split("+");
  let key = parts.pop() ?? token;
  if (key === "" && parts.length) {
    parts.pop();
    key = "+";
  }
  const modifiers = baseModifiers | modifierMask(parts.join("+"));
  const evt: Record<string, unknown> = { modifiers };
  let text: string | undefined;
  const named = KEY_TABLE[key];
  if (named) {
    evt.key = named.key ?? key;
    evt.code = named.code;
    evt.windowsVirtualKeyCode = named.vk;
    evt.nativeVirtualKeyCode = named.vk;
    text = named.text;
  } else if (key.length === 1) {
    evt.key = key;
    text = key;
    if (/[a-zA-Z]/.test(key)) {
      evt.code = `Key${key.toUpperCase()}`;
      evt.windowsVirtualKeyCode = evt.nativeVirtualKeyCode = key.toUpperCase().charCodeAt(0);
    } else if (/[0-9]/.test(key)) {
      evt.code = `Digit${key}`;
      evt.windowsVirtualKeyCode = evt.nativeVirtualKeyCode = key.charCodeAt(0);
    } else if (PUNCT_VK[key]) {
      evt.code = PUNCT_VK[key][0];
      evt.windowsVirtualKeyCode = evt.nativeVirtualKeyCode = PUNCT_VK[key][1];
    }
  } else {
    throw new NoFallbackError(
      `unknown key name "${key}" — use a single character or Enter/Tab/Escape/Backspace/Delete/Space/Home/End/PageUp/PageDown/Insert/Arrow*/F1-F12`,
    );
  }
  // A real keyboard inserts nothing while Ctrl/Alt/Meta is held (ctrl+a selects,
  // it does not type "a"); Shift alone still produces a character.
  if (text !== undefined && (modifiers & ~MOD_SHIFT) === 0) {
    evt.text = text;
    evt.unmodifiedText = text;
  }
  return evt;
}

async function ensureKeyboardPaint(tabId: number): Promise<void> {
  const PAINT_OBSERVATION_MS = 250;
  const PAINT_POLL_MS = 16;
  const read = async () => {
    const result = await cdpSend<{ result?: { value?: { document: number; painted: boolean } } }>(tabId, "Runtime.evaluate", {
      expression: "({document:performance.timeOrigin,painted:performance.getEntriesByType('paint').some(entry=>entry.name==='first-contentful-paint')})",
      returnByValue: true,
    });
    const state = result.result?.value;
    if (!state || !Number.isFinite(state.document)) throw new NoFallbackError("Keyboard readiness unavailable; no key was dispatched.");
    return state;
  };
  const before = await read();
  if (before.painted) return;
  // Chromium suppresses input while the new document defers its first paint.
  // A background surface capture produces that frame without selecting the tab
  // or changing its viewport. Discard pixels; never retry an input dispatch.
  await cdpSend(tabId, "Page.captureScreenshot", { format: "jpeg", quality: 0, captureBeyondViewport: false });
  // captureScreenshot can resolve one task before PerformancePaintTiming publishes
  // the frame it produced. Observe that marker briefly; never capture or dispatch
  // again, and fail immediately if the document identity changes.
  const deadline = Date.now() + PAINT_OBSERVATION_MS;
  for (;;) {
    const after = await read();
    if (after.document !== before.document) {
      throw new NoFallbackError("Page changed while waiting for first paint; no key was dispatched. Inspect the page before continuing.");
    }
    // A delayed ready response cannot authorize input after this observation budget.
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new NoFallbackError(`Page did not confirm first paint within ${PAINT_OBSERVATION_MS}ms; no key was dispatched. Inspect the page before continuing.`);
    }
    if (after.painted) return;
    await new Promise(resolve => setTimeout(resolve, Math.min(PAINT_POLL_MS, remaining)));
  }
}

export async function cdpInteract(args: {
  action: string;
  tabId: number;
  ref?: string;
  coordinate?: [number, number];
  text?: string;
  repeat?: number;
  modifiers?: string;
}): Promise<{ ok: boolean; info: string; via: string }> {
  const tabId = args.tabId;
  const refExpr = () => {
    const { base, frameId } = parseRef(String(args.ref));
    return deepByAttrExpr(base, frameId);
  };
  // Resolve a ref/coordinate to viewport coords + whether that point actually
  // hits the element (so we know a coordinate click will land on it).
  const resolveTarget = async (): Promise<{
    x: number;
    y: number;
    hits: boolean;
  }> => {
    if (args.coordinate)
      return { x: args.coordinate[0], y: args.coordinate[1], hits: true };
    if (args.ref) {
      const r = await evaluateRefInTab<any>(tabId, args.ref,
        `(()=>{const e=${refExpr()};e.scrollIntoView({block:'center',inline:'center'});const b=e.getBoundingClientRect();const x=b.left+b.width/2,y=b.top+b.height/2;const h=document.elementFromPoint(x,y);return {x,y,hits:!!h&&(h===e||e.contains(h)||h.contains(e))};})()`);
      const v = r?.result?.value;
      if (!v) throw new Error(`No element for ${args.ref}.`);
      return v;
    }
    throw new Error(`${args.action} needs ref or coordinate`);
  };
  // Reliable JS click via the page (used when a coordinate click wouldn't land
  // on the target — e.g. covered/odd layout). Fires real handlers.
  const jsClick = (kind: "click" | "dblclick") =>
    evaluateRefInTab(tabId, args.ref!,
      `(()=>{const e=${refExpr()};if(e.focus)e.focus();if(${refExpr()}!==e)throw new Error('Reference changed during focus');${
        kind === "dblclick"
          ? "e.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true}));"
          : "e.click();"
      }return true;})()`);
  // Authenticate the ref and move keyboard focus to it, so trusted input lands in
  // the named field and a stale ref fails before anything is dispatched. Focus
  // counts when it rests on the ref or inside it (a shadow host that delegates
  // focus), or on the editing host that contains a contenteditable ref.
  // A frame element is refused before it is focused: focus inside the frame
  // counts as focus on it, so the keys would go to whatever the frame has
  // focused. Insertion into a read-only or disabled control does nothing, so
  // for type it is not editable (the `:disabled` copy is listed in the banner of
  // injected-interaction-scripts.ts).
  const focusRef = async (requireEditable: boolean) => {
    const r = await evaluateRefInTab<any>(tabId, args.ref!,
      `(()=>{const e=${refExpr()};if(e.tagName==='IFRAME'||e.tagName==='FRAME')return {frame:true};if(typeof e.focus==='function')e.focus();let a=document.activeElement;while(a&&a.shadowRoot&&a.shadowRoot.activeElement)a=a.shadowRoot.activeElement;let n=a;while(n&&n!==e)n=n.parentElement||n.getRootNode().host;const field=!!a&&(a.tagName==='INPUT'||a.tagName==='TEXTAREA');return {focused:!!a&&(n===e||(e.isContentEditable===true&&a.contains(e))),editable:!!a&&(field&&a.readOnly!==true&&!a.matches(':disabled')||a.isContentEditable===true)};})()`);
    const state = r?.result?.value;
    if (state?.frame === true) {
      throw new NoFallbackError(`${args.ref} is a frame element, not a field in it; no input was dispatched. Pass the field's own frame ref (ref_N@frameId from read_page/find).`);
    }
    if (state?.focused !== true) throw new NoFallbackError(`${args.ref} could not take keyboard focus; no input was dispatched.`);
    if (requireEditable && state.editable !== true) throw new NoFallbackError(`${args.ref} is not an editable field (read-only, disabled or not a text field); nothing was typed.`);
  };
  const button = args.action === "right_click" ? "right" : "left";
  const buttonsMask = button === "right" ? 2 : 1;
  const mouse = (type: string, x: number, y: number, clickCount: number, pressed: boolean) =>
    cdpSend(tabId, "Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button,
      clickCount,
      buttons: pressed ? buttonsMask : 0,
    });

  switch (args.action) {
    case "left_click":
    case "right_click": {
      // Ref → reliable JS click/dispatch (fires real handlers + focus); works on a
      // backgrounded tab. Coordinate-only clicks are routed to the synthetic page
      // path by toolComputer (Input.dispatchMouseEvent is dropped on a hidden tab),
      // so the coordinate branch below only runs when a coordinate slips through.
      if (args.ref) {
        if (args.action === "right_click") {
          await evaluateRefInTab(tabId, args.ref,
            `(()=>{const e=${refExpr()};e.scrollIntoView({block:'center',inline:'center'});e.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));return true;})()`);
        } else {
          await jsClick("click");
        }
        return { ok: true, info: `${args.action} (ref)`, via: "ref-click" };
      }
      const t = await resolveTarget();
      await mouse("mouseMoved", t.x, t.y, 0, false);
      await mouse("mousePressed", t.x, t.y, 1, true);
      await mouse("mouseReleased", t.x, t.y, 1, false);
      return { ok: true, info: `${args.action} at ${Math.round(t.x)},${Math.round(t.y)}`, via: "cdp-coord" };
    }
    case "double_click": {
      if (args.ref) {
        await jsClick("dblclick");
        return { ok: true, info: "double_click (ref)", via: "ref-click" };
      }
      const t = await resolveTarget();
      await mouse("mousePressed", t.x, t.y, 1, true);
      await mouse("mouseReleased", t.x, t.y, 1, false);
      await mouse("mousePressed", t.x, t.y, 2, true);
      await mouse("mouseReleased", t.x, t.y, 2, false);
      return { ok: true, info: "double_click at coord", via: "cdp-coord" };
    }
    case "type": {
      if (typeof args.text !== "string") throw new Error("type needs text");
      if (args.ref) {
        await focusRef(true);
      } else {
        // Input.insertText into nothing is a silent no-op that would report ok —
        // require a focused editable (descending through shadow hosts).
        const focused = await cdpSend<any>(tabId, "Runtime.evaluate", {
          expression: `(()=>{let e=document.activeElement;while(e&&e.shadowRoot&&e.shadowRoot.activeElement)e=e.shadowRoot.activeElement;if(!e)return false;const t=e.tagName;if(t==='IFRAME'||t==='FRAME')return 'frame';return t==='INPUT'||t==='TEXTAREA'||e.isContentEditable===true;})()`,
          returnByValue: true,
        });
        // Every frame keeps its own active element and an unfocused window gives
        // no way to tell which frame Chrome would type into, so trusted typing
        // without a ref stays in the main frame instead of guessing.
        if (focused?.result?.value === "frame") {
          throw new NoFallbackError("Keyboard focus is inside a frame. Trusted typing without a ref reaches the main frame only; pass the field's own ref (ref_N@frameId from read_page/find) to type into it.");
        }
        if (focused?.result?.value !== true) {
          throw new NoFallbackError("no focused editable element — click the field first");
        }
      }
      await cdpSend(tabId, "Input.insertText", { text: args.text });
      return { ok: true, info: `typed ${args.text.length} chars`, via: "cdp" };
    }
    case "key": {
      if (typeof args.text !== "string") throw new Error("key needs text");
      // Clamped here too: the schema cap does not reach a raw/batch caller.
      const times = Math.min(200, Math.max(1, Math.floor(args.repeat ?? 1)));
      const base = modifierMask(args.modifiers ?? "");
      // Parse every token first: an unknown name fails the whole call before any
      // key is dispatched.
      const events = args.text
        .split(/\s+/)
        .filter(Boolean)
        .map((token) => keyEvent(token, base));
      if (args.ref) await focusRef(false);
      if (events.length) await ensureKeyboardPaint(tabId);
      for (let i = 0; i < times; i++) {
        for (const evt of events) {
          await cdpSend(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...evt });
          await cdpSend(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...evt });
        }
      }
      return { ok: true, info: `pressed ${args.text}`, via: "cdp" };
    }
  }
  throw new Error(`cdpInteract: unhandled ${args.action}`);
}
