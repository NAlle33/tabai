// Content script — runs in the page's MAIN world at document_start (declared
// in manifest.json). Wraps console + fetch/XHR to buffer logs and network
// requests for read_console_messages / read_network_requests. MAIN-world
// content scripts cannot use chrome.* APIs, so this only touches page globals;
// the readers (executeScript, MAIN world) read the buffers.

(() => {
  const w = window as any;

  // ---- console capture ----
  if (!w.__ccmcpConsoleInstalled) {
    w.__ccmcpConsoleInstalled = true;
    w.__ccmcpConsole = w.__ccmcpConsole || [];
    // Every console call on every page passes through here, so nothing here may
    // run page code, throw into the page's own call or grow without bound. Each
    // builtin used below is captured now, before page scripts run
    // (document_start): a page may later replace Array.from, Array.prototype.*,
    // String.prototype.slice or Function.prototype.call/apply, so no method is
    // looked up while a call is being captured.
    const apply = Reflect.apply, now = Date.now, toText = String, quote = JSON.stringify;
    const describe = Object.getOwnPropertyDescriptor, keysOf = Object.keys, hasOwn = Object.prototype.hasOwnProperty;
    const isArray = Array.isArray, isView = ArrayBuffer.isView, push = Array.prototype.push, shift = Array.prototype.shift;
    const sliceText = String.prototype.slice, unboxText = String.prototype.valueOf;
    const dateTime = Date.prototype.getTime, dateIso = Date.prototype.toISOString;
    const cut = (text: string, length: number): string => apply(sliceText, text, [0, length]);
    // A descriptor's own `value` only: an inherited one would come from the page's Object.prototype.
    const ownValue = (descriptor: PropertyDescriptor | undefined): descriptor is PropertyDescriptor & { value: unknown } =>
      descriptor !== undefined && apply(hasOwn, descriptor, ["value"]);
    const MAX_TEXT = 4000; // cap per-entry text so a logged giant object can't grow the buffer unbounded
    const pushLog = (level: string, text: string) => {
      try {
        const buffer = w.__ccmcpConsole;
        apply(push, buffer, [{ level, text: text.length > MAX_TEXT ? cut(text, MAX_TEXT) + "…[truncated]" : text, ts: now() }]);
        if (buffer.length > 500) apply(shift, buffer, []);
      } catch {
        /* ignore */
      }
    };
    // Formatting reads own data properties only, through descriptors (no
    // getter, no toJSON, no toString), to depth 2, 20 keys or items per level,
    // and builds nothing past MAX_TEXT.
    const MAX_DEPTH = 2, MAX_KEYS = 20;
    const quoted = (text: string): string => quote(text.length > MAX_TEXT ? cut(text, MAX_TEXT) : text);
    const fmt = (args: unknown[]): string => {
      let out = "";
      const emit = (text: string) => { if (out.length <= MAX_TEXT) out += cut(text, MAX_TEXT + 1 - out.length); };
      // One slot per walked level (MAX_DEPTH), created by the literal: writing a
      // slot then never reaches a setter a page defined on Array.prototype.
      const ancestors: unknown[] = [null, null];
      const walk = (value: unknown, depth: number): void => {
        if (out.length > MAX_TEXT) return;
        if (value === null) return emit("null");
        switch (typeof value) {
          case "string": return emit(quoted(value));
          case "number": case "boolean": case "bigint": case "symbol": return emit(toText(value));
          // Also document.all, an object: converting it would run the page's own code.
          case "undefined": return emit("undefined");
          case "function": return emit("[Function]");
        }
        const object = value as object;
        // A typed array or DataView can hold millions of elements: never walk one.
        if (isView(object)) return emit("[Binary]");
        // A String wrapper lists one key per character. valueOf is a brand check:
        // it throws for anything else, and page code never runs.
        let boxed: unknown;
        try { boxed = apply(unboxText, object, []); } catch { /* not a String wrapper */ }
        if (typeof boxed === "string") return emit(quoted(boxed));
        let date: string | undefined;
        // getTime is a brand check: it throws for anything but a Date, page code never runs.
        try { apply(dateTime, object, []); date = "Invalid Date"; date = apply(dateIso, object, []); } catch { /* not a date, or invalid */ }
        if (date !== undefined) return emit(quote(date));
        for (let level = 0; level < depth; level++) if (ancestors[level] === object) return emit("[Circular]");
        const array = isArray(object);
        if (depth >= MAX_DEPTH) return emit(array ? "[Array]" : "[Object]");
        let keys: string[] = [], offset = 0, count = 0;
        if (array) {
          const length = describe(object, "length");
          if (ownValue(length) && typeof length.value === "number") count = length.value;
        } else {
          keys = keysOf(object);
          // An Error keeps its message in an own, non-enumerable data property.
          const message = describe(object, "message");
          if (ownValue(message) && !message.enumerable && typeof message.value === "string") offset = 1;
          count = keys.length + offset;
        }
        ancestors[depth] = object;
        emit(array ? "[" : "{");
        for (let index = 0; index < count && out.length <= MAX_TEXT; index++) {
          if (index) emit(",");
          if (index === MAX_KEYS) { emit("…"); break; }
          const key = array ? "" + index : index < offset ? "message" : keys[index - offset];
          if (!array) emit(quote(key) + ":");
          const descriptor = describe(object, key);
          if (ownValue(descriptor)) walk(descriptor.value, depth + 1);
          else emit(descriptor ? "[Getter]" : "undefined");
        }
        emit(array ? "]" : "}");
      };
      for (let index = 0; index < args.length; index++) {
        if (index) emit(" ");
        const arg = args[index];
        try {
          if (typeof arg === "string") emit(arg);
          else walk(arg, 0);
        } catch { emit("[Unreadable]"); }
      }
      return out;
    };
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      const orig = (console as any)[level];
      (console as any)[level] = function (this: unknown, ...args: unknown[]) {
        // Nothing the capture does may make the page's own console call fail.
        try { pushLog(level, fmt(args)); } catch { /* ignore */ }
        return apply(orig, this, args);
      };
    }
    window.addEventListener("error", (e) =>
      pushLog("error", `Uncaught ${e.message}`),
    );
    // The reason is page data: formatted like a console argument, never through its own toString.
    window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
      try { pushLog("error", "Unhandled rejection: " + fmt([e.reason])); } catch { /* ignore */ }
    });
  }

  // ---- network capture (fetch + XHR) ----
  w.__ccmcpNetwork = w.__ccmcpNetwork || [];
  if (typeof w.__ccmcpInflight !== "number") w.__ccmcpInflight = 0;
  const incInflight = () => (w.__ccmcpInflight += 1);
  const decInflight = () => (w.__ccmcpInflight = Math.max(0, w.__ccmcpInflight - 1));
  const pushNet = (entry: any) => {
    try {
      if (entry && typeof entry.url === "string" && entry.url.length > 2000) {
        entry.url = entry.url.slice(0, 2000) + "…"; // cap giant URLs (e.g. data:) per entry
      }
      w.__ccmcpNetwork.push(entry);
      if (w.__ccmcpNetwork.length > 500) w.__ccmcpNetwork.shift();
    } catch {
      /* ignore */
    }
  };

  if (!w.__ccmcpFetchWrapped && typeof window.fetch === "function") {
    w.__ccmcpFetchWrapped = true;
    const origFetch = window.fetch.bind(window);
    window.fetch = function (input: any, init?: any) {
      const url =
        typeof input === "string"
          ? input
          : (input && input.url) || String(input);
      const method = String(
        init?.method ||
        (input && typeof input === "object" && input.method) ||
        "GET",
      ).toUpperCase();
      const start = Date.now();
      incInflight();
      let request: Promise<Response>;
      try {
        request = origFetch(input, init);
      } catch (error) {
        decInflight();
        throw error;
      }
      return request.then(
        (resp: Response) => {
          decInflight();
          pushNet({ type: "fetch", method, url, status: resp.status, ms: Date.now() - start, ts: start });
          return resp;
        },
        (err: any) => {
          decInflight();
          pushNet({ type: "fetch", method, url, status: 0, error: String(err), ms: Date.now() - start, ts: start });
          throw err;
        },
      );
    } as typeof window.fetch;
  }

  if (!w.__ccmcpXhrWrapped && typeof window.XMLHttpRequest === "function") {
    w.__ccmcpXhrWrapped = true;
    const XHR = window.XMLHttpRequest;
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    XHR.prototype.open = function (this: any, method: string, url: string) {
      this.__ccmcp = { method: String(method).toUpperCase(), url: String(url), start: 0 };
      return (open as any).apply(this, arguments);
    };
    XHR.prototype.send = function (this: any) {
      const meta = this.__ccmcp;
      let finish: (() => void) | undefined;
      if (meta) {
        meta.start = Date.now();
        incInflight();
        let counted = true;
        finish = () => {
          if (!counted) return;
          counted = false;
          decInflight();
          pushNet({ type: "xhr", method: meta.method, url: meta.url, status: this.status, ms: Date.now() - meta.start, ts: meta.start });
        };
        this.addEventListener("loadend", finish, { once: true });
      }
      try {
        return (send as any).apply(this, arguments);
      } catch (error) {
        if (finish) {
          this.removeEventListener("loadend", finish);
          finish();
        }
        throw error;
      }
    };
  }
})();
