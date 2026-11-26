// Serialized by Chrome: each function must remain self-contained, including its inline resolver/predicates.
//
// DUPLICATED PREDICATES — change every copy together (full lists in the banners
// of injected-page-scripts.ts and injected-interaction-scripts.ts):
// - the ref resolver in all three functions;
// - `isSecretField` in formInputInPage / fillFormInPage, with pageQuery's copy,
//   perception's `secret` and the autocomplete-token rule in src/assistant-web.ts;
// - the enabled test `matches(":disabled")` in formInputInPage / fillFormInPage,
//   with sampleActionableInPage, pageInteract, pointerTargetInPage, perception,
//   focusRef in computer-input.ts and webElementScript in src/assistant-web.ts;
// - the checkbox/radio + read-back logic between formInputInPage and fillFormInPage.

/** form_input: set a value on a form element resolved by ref, then READ IT BACK —
 *  `ok` means the field now holds the value, not merely that a setter ran. */
export function formInputInPage(
  ref: string,
  value: string | boolean | number,
): { ok: boolean; error?: string; ref?: string; tag?: string } {
  // Inline ref resolver (must be self-contained — see the file banner).
  const resolve = (r: string): any => {
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
  // Duplicated from pageQuery (see the file banner): never echo a secret value.
  const isSecretField = (el: any): boolean => {
    const tag = el.tagName.toLowerCase();
    if (tag !== "input" && tag !== "textarea") return false;
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "password" || type === "hidden") return true;
    const tokens: string[] = (el.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/);
    if (tokens.some(token => token === "current-password" || token === "new-password" || token === "one-time-code" || token.startsWith("cc-"))) return true;
    return /pass|otp|cvv|cvc/i.test((el.getAttribute("name") || "") + " " + (el.id || ""));
  };
  if (!/^ref_\d+$/.test(ref)) return { ok: false, error: `invalid ref "${String(ref).slice(0, 40)}"` };
  let el: any;
  try { el = resolve(ref); }
  catch (error) { return { ok: false, error: String((error as Error)?.message ?? error) }; }
  if (!el)
    return { ok: false, error: `No element for ${ref}. Call read_page/find first.` };
  const tag = el.tagName.toLowerCase();
  const fire = (t: string) =>
    el.dispatchEvent(new Event(t, { bubbles: true }));
  const rejected = (got: string) =>
    isSecretField(el)
      ? `value rejected by the field (secret field; length ${got.length})`
      : `value rejected by the field (got "${got.slice(0, 60)}")`;
  try {
    if (tag === "input" || tag === "textarea") {
      if (el.matches(":disabled")) return { ok: false, error: `field is disabled` };
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") {
        // String booleans: "false" / "0" / "no" / "off" / "" mean unchecked.
        const want = typeof value === "string" ? !/^(false|0|no|off|)$/i.test(value.trim()) : Boolean(value);
        // Frameworks that own the `checked` state (React) listen for a real
        // click and ignore a property write + synthetic change — so toggle with
        // a click, exactly as a user would; a radio cannot be un-clicked.
        if (type === "checkbox") {
          if (el.checked !== want) el.click();
        } else if (want && !el.checked) {
          el.click();
        } else if (!want && el.checked) {
          el.checked = false;
          fire("input");
          fire("change");
        }
        if (el.checked !== want) return { ok: false, error: "state did not change (page handler reverted it)" };
        return { ok: true, ref, tag };
      }
      if (el.readOnly) return { ok: false, error: `field is read-only` };
      // Use the native setter so frameworks (React) detect the change.
      const proto =
        tag === "textarea"
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, String(value));
      else el.value = String(value);
      fire("input");
      fire("change");
      // Read-back: the UA sanitizes (number/date), and page handlers may
      // reformat or reject — report what the field actually holds.
      if (el.value !== String(value)) return { ok: false, error: rejected(String(el.value)) };
    } else if (tag === "select") {
      const opts: any[] = Array.from(el.options);
      const m =
        opts.find((o) => o.value === String(value)) ||
        opts.find((o) => o.text.trim() === String(value));
      if (!m) return { ok: false, error: `No option matching "${value}"` };
      if (el.matches(":disabled")) return { ok: false, error: `field is disabled` };
      el.value = m.value;
      fire("input");
      fire("change");
      if (el.value !== m.value) return { ok: false, error: rejected(String(el.value)) };
    } else if (el.isContentEditable) {
      el.textContent = String(value);
      fire("input");
      if (el.textContent !== String(value)) return { ok: false, error: rejected(String(el.textContent)) };
    } else {
      return { ok: false, error: `Element ${ref} (${tag}) is not a form field` };
    }
    return { ok: true, ref, tag };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}


/** fill_form: set many fields by ref in ONE round-trip, then optionally submit.
 *  Self-contained (serialized by func.toString()) — re-declares the ref resolver +
 *  set-value logic from formInputInPage; they can't be shared into the page. */
export function fillFormInPage(
  fields: { ref: string; value: string | boolean | number }[],
  submitRef?: string | null,
): {
  ok: boolean;
  results: { ref: string; ok: boolean; error?: string }[];
  submitted?: boolean;
} {
  const resolve = (r: string): any => {
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
  // Duplicated from pageQuery (see the file banner): never echo a secret value.
  const isSecretField = (el: any): boolean => {
    const tag = el.tagName.toLowerCase();
    if (tag !== "input" && tag !== "textarea") return false;
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "password" || type === "hidden") return true;
    const tokens: string[] = (el.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/);
    if (tokens.some(token => token === "current-password" || token === "new-password" || token === "one-time-code" || token.startsWith("cc-"))) return true;
    return /pass|otp|cvv|cvc/i.test((el.getAttribute("name") || "") + " " + (el.id || ""));
  };
  // Same set + read-back logic as formInputInPage (see the file banner).
  const setOne = (ref: string, value: any): { ref: string; ok: boolean; error?: string } => {
    if (!/^ref_\d+$/.test(ref)) return { ref, ok: false, error: "invalid ref" };
    let el: any;
    try { el = resolve(ref); }
    catch (error) { return { ref, ok: false, error: String((error as Error)?.message ?? error) }; }
    if (!el) return { ref, ok: false, error: "not found (call read_page/find first)" };
    const tag = el.tagName.toLowerCase();
    const fire = (t: string) => el.dispatchEvent(new Event(t, { bubbles: true }));
    const rejected = (got: string) =>
      isSecretField(el)
        ? `value rejected by the field (secret field; length ${got.length})`
        : `value rejected by the field (got "${got.slice(0, 60)}")`;
    try {
      if (tag === "input" || tag === "textarea") {
        if (el.matches(":disabled")) return { ref, ok: false, error: "field is disabled" };
        const type = (el.getAttribute("type") || "text").toLowerCase();
        if (type === "checkbox" || type === "radio") {
          const want = typeof value === "string" ? !/^(false|0|no|off|)$/i.test(value.trim()) : Boolean(value);
          if (type === "checkbox") {
            if (el.checked !== want) el.click();
          } else if (want && !el.checked) {
            el.click();
          } else if (!want && el.checked) {
            el.checked = false;
            fire("input");
            fire("change");
          }
          if (el.checked !== want) return { ref, ok: false, error: "state did not change (page handler reverted it)" };
          return { ref, ok: true };
        }
        if (el.readOnly) return { ref, ok: false, error: "field is read-only" };
        const proto = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(el, String(value));
        else el.value = String(value);
        fire("input");
        fire("change");
        if (el.value !== String(value)) return { ref, ok: false, error: rejected(String(el.value)) };
      } else if (tag === "select") {
        const opts: any[] = Array.from(el.options);
        const opt =
          opts.find((o) => o.value === String(value)) ||
          opts.find((o) => o.text.trim() === String(value));
        if (!opt) return { ref, ok: false, error: `no option matching "${value}"` };
        if (el.matches(":disabled")) return { ref, ok: false, error: "field is disabled" };
        el.value = opt.value;
        fire("input");
        fire("change");
        if (el.value !== opt.value) return { ref, ok: false, error: rejected(String(el.value)) };
      } else if (el.isContentEditable) {
        el.textContent = String(value);
        fire("input");
        if (el.textContent !== String(value)) return { ref, ok: false, error: rejected(String(el.textContent)) };
      } else {
        return { ref, ok: false, error: `${tag} is not a form field` };
      }
      return { ref, ok: true };
    } catch (e: any) {
      return { ref, ok: false, error: String(e?.message ?? e) };
    }
  };
  const referenceErrors = new Map<string, string>();
  for (const ref of [...fields.map(field => field.ref), ...(submitRef ? [submitRef] : [])]) {
    try { resolve(ref); }
    catch (error) { referenceErrors.set(ref, String((error as Error)?.message ?? error)); }
  }
  if (referenceErrors.size) {
    const reason = [...referenceErrors.values()].join("; ");
    return {
      ok: false,
      results: fields.map(field => ({ ref: field.ref, ok: false,
        error: referenceErrors.get(field.ref) || `Not changed: ${reason}` })),
      ...(submitRef ? { submitted: false } : {}),
    };
  }
  const results = fields.map((f) => setOne(f.ref, f.value));
  let submitted: boolean | undefined;
  if (submitRef) {
    try {
      const s: any = resolve(submitRef);
      if (s) {
        if (s.focus) s.focus();
        s.click();
        submitted = true;
      } else {
        submitted = false;
      }
    } catch {
      submitted = false;
    }
  }
  // ok folds in the submit outcome: a requested-but-not-found submit fails the call.
  return {
    ok: results.every((r) => r.ok) && submitted !== false,
    results,
    ...(submitRef ? { submitted } : {}),
  };
}


/** select_option: native <select> by value/label, or best-effort ARIA/custom. */
export function selectOptionInPage(
  ref: string,
  value: string,
): {
  ok: boolean;
  error?: string;
  selected?: string;
  native?: boolean;
  opened?: boolean;
  verified?: boolean;
} {
  const resolve = (r: string): any => {
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
  if (!/^ref_\d+$/.test(ref)) return { ok: false, error: `invalid ref "${String(ref).slice(0, 40)}"` };
  let el: any;
  try { el = resolve(ref); }
  catch (error) { return { ok: false, error: String((error as Error)?.message ?? error) }; }
  if (!el) return { ok: false, error: `No element for ${ref}. Call read_page/find first.` };
  const want = String(value);
  // One rule for native and custom lists: an exact value, else an exact text,
  // else a substring of the text — and each stage counts only a single match.
  // Several matches are refused with their labels: taking the first would
  // select an option the caller never named.
  const choose = (options: any[], valueOf: (o: any) => string | null, labelOf: (o: any) => string): { option?: any; error?: string } => {
    for (const matches of [(o: any) => valueOf(o) === want, (o: any) => labelOf(o) === want, (o: any) => labelOf(o).includes(want)]) {
      const found = options.filter(matches);
      // An option nested inside another matching option is the same choice.
      const distinct = found.filter(o => !found.some(other => other !== o && other.contains(o)));
      if (distinct.length === 1) return { option: distinct[0] };
      if (distinct.length > 1) {
        const labels = distinct.slice(0, 10).map(o => `"${labelOf(o).slice(0, 60)}"`).join(", ");
        return { error: `"${want}" matches ${distinct.length} options (${labels}${distinct.length > 10 ? ", …" : ""}); pass the exact value or text of one` };
      }
    }
    return {};
  };
  const tag = el.tagName.toLowerCase();
  if (tag === "select") {
    const { option, error } = choose(Array.from(el.options), o => o.value, o => o.text.trim());
    if (!option) return { ok: false, error: error ?? `No option matching "${value}"` };
    // selectedIndex selects this very option even when another shares its value.
    el.selectedIndex = option.index;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    if (!option.selected) return { ok: false, error: `value rejected by the field (got "${String(el.value).slice(0, 60)}")` };
    return { ok: true, selected: option.text.trim(), native: true, verified: true };
  }
  // Custom/ARIA: open the control, then activate a matching option (best-effort;
  // options that render async may need a wait_for + computer click instead).
  // "Visible" means painted: an always-mounted menu with visibility:hidden or
  // opacity:0 has client rects but is not open.
  const isShown = (n: any): boolean => {
    if (!n.getClientRects || n.getClientRects().length === 0) return false;
    const cs = getComputedStyle(n);
    return cs.visibility !== "hidden" && Number(cs.opacity) > 0;
  };
  const popups = () => Array.from(document.querySelectorAll('[role="listbox"],[role="menu"]')) as any[];
  // Snapshot what is already open, then open THIS control: only a popup that
  // newly appeared can be its listbox. A decoy that was visible before the
  // click (another dropdown, a hidden nav menu) is never chosen.
  const before = new Set(popups().filter(isShown));
  el.click();
  const appeared = popups().filter((n) => isShown(n) && !before.has(n));
  const ariaId = el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
  const scope: any =
    (appeared.length === 1 ? appeared[0] : null) ||
    (ariaId && document.getElementById(ariaId)) ||
    el.querySelector('[role="listbox"],[role="menu"]') ||
    null;
  const root: any = scope || el;
  const candidates: any[] = Array.from(
    root.querySelectorAll('[role="option"], li, [data-value]'),
  );
  const { option: opt, error } = choose(candidates, o => o.getAttribute("data-value"), o => (o.textContent || "").trim());
  if (!opt)
    return {
      ok: false,
      opened: true,
      error: error ?? `opened control but no option matching "${value}" rendered yet — try wait_for then computer click`,
    };
  // Headless-UI libraries (downshift, react-select, Radix) commit on mousedown,
  // not click — send the pointer sequence a real click produces.
  for (const t of ["mousedown", "mouseup", "click"]) {
    opt.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
  }
  const label = (opt.textContent || "").trim();
  // Verified only by the chosen option's own state. The control's text proves
  // nothing: a list rendered inside the control always contains every label.
  // false is an honest "dispatched, not confirmed".
  const verified = opt.getAttribute("aria-selected") === "true" || opt.getAttribute("aria-checked") === "true";
  return { ok: true, selected: label, native: false, verified };
}
