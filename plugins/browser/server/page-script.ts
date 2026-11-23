// Code that runs inside web pages. It is serialized with Function.prototype.toString and evaluated through CDP
// (Runtime.evaluate), so page CSP does not block it. It must be self-contained: no references to module scope.
// Elements get stable refs in a `data-owl-ref` attribute; the counter lives in the plugin, so refs never repeat
// across navigations (an old ref can not silently point at a different element on a new page).

declare const document: any;
declare const window: any;
declare const getComputedStyle: any;
declare const CSS: any;
declare const location: any;

export function pageScript(op: string, a: any): any {
  const norm = (s: any) => String(s ?? "").replace(/\s+/g, " ").trim();
  const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  // Rules from safety.ts (PAGE_RULES): what counts as an action with consequences.
  const rules = a.rules || {};
  const ACTION = new RegExp(rules.action || "$^", "iu");
  const LINK_ACTION = new RegExp(rules.link || "$^", "iu");
  const LINK_PATH = new RegExp(rules.linkPath || "$^", "i");
  const HINT = new RegExp(rules.hint || "$^", "i");
  const CHECKOUT_FORM = new RegExp(rules.checkoutForm || "$^", "iu");
  const PROCEED = new RegExp(rules.proceed || "$^", "iu");
  // A site's check instead of the page: a captcha, or one that passes by itself.
  const CHECK = new RegExp(rules.check || "$^", "iu");
  const CHECK_PASSING = new RegExp(rules.checkPassing || "$^", "iu");
  // A step of signing in: what its fields are, and words of signing up instead.
  const CREDENTIAL = new RegExp(rules.credential || "$^", "iu");
  const SIGN_UP = new RegExp(rules.signUp || "$^", "iu");
  const LINK_WORDS = Number(rules.linkWords) || 6;
  /** Roles that only focus, tick or choose: clicking them is never the action itself (the form's submit is). */
  const FIELD_ROLES = ["checkbox", "radio", "option", "tab", "combobox", "textbox", "searchbox", "slider", "spinbutton", "menuitemcheckbox", "menuitemradio", "listbox", "treeitem"];
  const TEXT_INPUTS = ["", "text", "email", "password", "search", "tel", "url", "number", "date", "datetime-local", "month", "week", "time"];
  const INTERACTIVE =
    'a[href], button, input:not([type="hidden" i]), textarea, select, summary, [contenteditable=""], [contenteditable="true"], ' +
    '[role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], ' +
    '[role="menuitemradio"], [role="option"], [role="switch"], [role="combobox"], [role="textbox"], [role="searchbox"], [role="slider"], ' +
    '[role="spinbutton"], [role="treeitem"], [onclick], [tabindex]:not([tabindex="-1"])';

  // ---------- DOM walking (open shadow roots included) ----------
  function allElements(root: any, out: any[]) {
    const list = root.querySelectorAll("*");
    for (const el of list) {
      out.push(el);
      if (el.shadowRoot) allElements(el.shadowRoot, out);
    }
    return out;
  }
  function byRef(ref: string) {
    const sel = '[data-owl-ref="' + CSS.escape(ref) + '"]';
    const direct = document.querySelector(sel);
    if (direct) return direct;
    for (const el of allElements(document, [])) if (el.shadowRoot) {
      const found = el.shadowRoot.querySelector(sel);
      if (found) return found;
    }
    return null;
  }
  function visible(el: any) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (el.checkVisibility && !el.checkVisibility({ checkVisibilityCSS: true })) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none";
  }

  // ---------- naming and roles ----------
  function textOfIds(el: any, ids: string) {
    const doc = el.getRootNode && el.getRootNode().getElementById ? el.getRootNode() : document;
    return ids
      .split(/\s+/)
      .map((id: string) => {
        const t = doc.getElementById(id) || document.getElementById(id);
        return t ? t.innerText || t.textContent || "" : "";
      })
      .join(" ");
  }
  function nameOf(el: any): string {
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const t = norm(textOfIds(el, lb));
      if (t) return t;
    }
    const al = norm(el.getAttribute("aria-label"));
    if (al) return al;
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const type = String(el.type || "").toLowerCase();
      if (type === "submit" || type === "button" || type === "reset") return norm(el.value) || (type === "submit" ? "Submit" : "");
      if (type === "image") return norm(el.alt) || norm(el.value) || "Submit";
      const labels = el.labels ? Array.from(el.labels).map((l: any) => l.innerText).join(" ") : "";
      return norm(labels) || norm(el.placeholder) || norm(el.title) || norm(el.getAttribute("data-placeholder")) || norm(el.name);
    }
    const text = norm(el.innerText);
    if (text) return text;
    const img = el.querySelector && el.querySelector("img[alt]");
    if (img && norm(img.alt)) return norm(img.alt);
    if (norm(el.title)) return norm(el.title);
    const svgTitle = el.querySelector && el.querySelector("svg title");
    if (svgTitle) return norm(svgTitle.textContent);
    return norm(el.getAttribute("data-placeholder") || el.getAttribute("placeholder"));
  }
  function roleOf(el: any): string {
    const explicit = norm(el.getAttribute("role"));
    if (explicit) return explicit.split(" ")[0];
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "select";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const t = String(el.type || "text").toLowerCase();
      if (t === "checkbox" || t === "radio") return t;
      if (t === "submit" || t === "button" || t === "reset" || t === "image") return "button";
      if (t === "range") return "slider";
      if (t === "file") return "file";
      if (t === "color") return "color";
      return "textbox";
    }
    if (el.isContentEditable) return "textbox";
    return "clickable";
  }
  function isEditable(el: any) {
    const tag = el.tagName.toLowerCase();
    if (tag === "textarea") return !el.readOnly && !el.disabled;
    if (tag === "input") return TEXT_INPUTS.includes(String(el.getAttribute("type") || "").toLowerCase()) && !el.readOnly && !el.disabled;
    return !!el.isContentEditable || ["textbox", "searchbox", "combobox"].includes(norm(el.getAttribute("role")));
  }
  function isSecret(el: any) {
    return el.getAttribute("data-owl-secret") === "1" || String(el.type || "").toLowerCase() === "password";
  }
  function isSearch(el: any, form: any) {
    if (el.closest && el.closest('[role="search"]')) return true;
    if (String(el.getAttribute("type") || "").toLowerCase() === "search") return true;
    if (!form) return false;
    const hint = [form.id, form.getAttribute("class"), form.getAttribute("action"), form.getAttribute("name"), form.getAttribute("aria-label")].join(" ");
    // "poisk" is Russian for search.
    if (/search|\u043f\u043e\u0438\u0441\u043a/i.test(hint)) return true;
    if (form.querySelector('input[type="search" i]')) {
      const fields = Array.from(form.querySelectorAll("input, select, textarea")).filter((f: any) => {
        const t = String(f.type || "").toLowerCase();
        return !["hidden", "submit", "button", "image", "reset"].includes(t);
      });
      return fields.length <= 3 && !form.querySelector('input[type="password" i]');
    }
    return false;
  }
  function realLink(el: any) {
    if (el.tagName.toLowerCase() !== "a" || el.getAttribute("role") === "button") return false;
    const href = el.getAttribute("href") || "";
    return !!href && !href.startsWith("#") && !/^javascript:/i.test(href);
  }
  /** Identifiers as words: "placeYourOrder1" → "place Your Order", "btn-delete" → "btn delete". */
  function words(s: any) {
    return String(s ?? "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_\-.:\/\\\d]+/g, " ");
  }
  /** Fields and choices: typing into them, ticking or choosing is not the action itself. */
  /**
   * A step of signing in, not up: the form asks only for a username, an email or a phone, the current password or a
   * one-time code. Moving it on signs the person in on this site and needs no approval; creating an account still does.
   */
  function signInStep(form: any, label: string) {
    if (!form || SIGN_UP.test(label)) return false;
    const fields = Array.from(form.querySelectorAll("input, select, textarea")).filter((f: any) => {
      const type = String(f.getAttribute("type") || "text").toLowerCase();
      return !["hidden", "submit", "button", "image", "reset", "checkbox", "radio"].includes(type) && visible(f);
    });
    if (!fields.length || fields.length > 3) return false;
    return fields.every((f: any) => {
      const type = String(f.getAttribute("type") || "text").toLowerCase();
      const ac = String(f.getAttribute("autocomplete") || "").toLowerCase();
      if (ac.includes("new-password")) return false;
      if (type === "password" || type === "email" || type === "tel" || /\b(username|email|tel|current-password|one-time-code)\b/.test(ac)) return true;
      return CREDENTIAL.test([f.getAttribute("name"), f.id, f.getAttribute("aria-label"), f.getAttribute("placeholder"), nameOf(f)].map(words).join(" "));
    });
  }
  function fieldLike(el: any) {
    const tag = el.tagName.toLowerCase();
    if (tag === "select" || tag === "textarea" || tag === "option") return true;
    if (tag === "input") {
      const t = String(el.getAttribute("type") || "text").toLowerCase();
      return !["submit", "button", "image", "reset"].includes(t);
    }
    if (el.isContentEditable) return true;
    return FIELD_ROLES.includes(norm(el.getAttribute("role")).split(" ")[0]);
  }
  /** Everything the control says about itself: name, its own text (not a container's), value, title, alt. */
  function actionText(ctrl: any, label: string) {
    const parts = [label];
    const nested = ctrl.querySelector && ctrl.querySelector("a[href], button, input, select, textarea");
    if (!nested) parts.push(norm(ctrl.innerText));
    for (const at of ["aria-label", "title", "value", "alt", "aria-description"]) parts.push(norm(ctrl.getAttribute(at)));
    return parts.filter(Boolean).join(" | ");
  }
  /** id, name, test ids and formaction as words, for icon-only controls like <button id="placeYourOrder">. */
  function hintText(ctrl: any) {
    const out: string[] = [];
    for (const at of ["id", "name", "data-testid", "data-test-id", "data-test", "data-qa", "data-cy", "data-action", "formaction"]) {
      const v = ctrl.getAttribute(at);
      if (v) out.push(words(v));
    }
    return out.join(" | ");
  }
  /** The site asks for confirmation itself (Rails data-confirm, onclick="return confirm(...)"): the click matters. */
  function asksConfirm(ctrl: any) {
    if (ctrl.hasAttribute("data-confirm") || ctrl.hasAttribute("data-turbo-confirm")) return true;
    return /\bconfirm\s*\(/.test(String(ctrl.getAttribute("onclick") || ""));
  }
  /** A link that acts when opened: /items/5/delete, ?action=unsubscribe, or a non-GET request (data-method). */
  function linkActs(ctrl: any) {
    const method = String(ctrl.getAttribute("data-method") || ctrl.getAttribute("data-turbo-method") || "").toLowerCase();
    if (method && method !== "get") return true;
    try {
      const u = new URL(ctrl.getAttribute("href"), location.href);
      for (const seg of u.pathname.split("/")) {
        let s = seg;
        try {
          s = decodeURIComponent(seg);
        } catch {
          /* keep raw */
        }
        if (LINK_PATH.test(s)) return true;
      }
      for (const [k, v] of u.searchParams) if (/^(?:action|do|op|cmd|method|_method)$/i.test(k) && LINK_PATH.test(v)) return true;
    } catch {
      /* not a URL */
    }
    return false;
  }
  /** Is activating this element an action with consequences (form submit, buy, send, delete...)? */
  function classify(el: any) {
    // Clicking a <label> activates its control (which may be a submit button).
    const target = el.tagName === "LABEL" && el.control ? el.control : el;
    const ctrl = (target.closest && target.closest('button, input[type="submit" i], input[type="image" i], a[href], [role="button"], [role="link"], [role="menuitem"]')) || target;
    const tag = ctrl.tagName.toLowerCase();
    const type = String(ctrl.getAttribute("type") || "").toLowerCase();
    const form = ctrl.form || (ctrl.closest && ctrl.closest("form"));
    const label = nameOf(ctrl) + (tag === "input" ? " " + norm(ctrl.value) : "");
    const search = isSearch(ctrl, form);
    let submit = false;
    let reason = "";
    const mark = (why: string) => {
      submit = true;
      reason = why;
    };
    if (fieldLike(target) && ctrl === target) {
      // Typing, ticking and choosing: the form's own submit (or Enter) is the action, and that one is checked.
    } else if (realLink(ctrl)) {
      if (LINK_ACTION.test(label) && label.split(" ").length <= LINK_WORDS) mark("label");
      else if (linkActs(ctrl)) mark("link");
      else if (asksConfirm(ctrl)) mark("confirm");
    } else if (ACTION.test(actionText(ctrl, label)) || HINT.test(hintText(ctrl))) {
      mark("label");
    } else if (asksConfirm(ctrl)) {
      mark("confirm");
    } else if (form && !search && ((tag === "button" && (type === "" || type === "submit")) || (tag === "input" && (type === "submit" || type === "image")))) {
      if (!signInStep(form, label)) mark("form");
    } else if (form && !search && type !== "reset" && (tag === "button" || norm(ctrl.getAttribute("role")) === "button") && PROCEED.test(label)) {
      // A JS wizard's "Continue" in a checkout or payment form.
      const formHint = [form.id, form.getAttribute("name"), form.getAttribute("class"), form.getAttribute("action"), form.getAttribute("aria-label")].map(words).join(" ");
      if (CHECKOUT_FORM.test(formHint)) mark("form");
    }
    return {
      submit,
      reason,
      search,
      inForm: !!form,
      editable: isEditable(el),
      tag: el.tagName.toLowerCase(),
      inputType: el.tagName.toLowerCase() === "input" ? String(el.getAttribute("type") || "text").toLowerCase() : "",
      role: roleOf(el),
      name: cut(nameOf(el), 80),
      href: realLink(ctrl) ? ctrl.href : "",
    };
  }
  function assignRef(el: any) {
    let ref = el.getAttribute("data-owl-ref");
    if (!ref) {
      ref = "e" + a.seq++;
      el.setAttribute("data-owl-ref", ref);
    }
    return ref;
  }
  function shortHref(href: string) {
    try {
      const u = new URL(href, location.href);
      if (u.origin === location.origin) return cut(u.pathname + u.search + u.hash, 80);
      return cut(u.href, 80);
    } catch {
      return cut(href, 80);
    }
  }
  /** A visible modal dialog: only its elements can be used while it is open. */
  function modalRoot() {
    for (const c of document.querySelectorAll('dialog[open], [aria-modal="true"], [role="alertdialog"]')) {
      if (c.tagName === "DIALOG" && !c.matches(":modal")) continue;
      if (visible(c)) return c;
    }
    return null;
  }
  function deepActive() {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }

  // ---------- operations ----------
  if (op === "snapshot") {
    const limit = a.limit || 100;
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const modal = modalRoot();
    const scope = modal || document;
    const cands: any[] = [];
    // Refs must be unique: cloned nodes (carousels) or a page copying our attributes would make a ref ambiguous.
    const everything = allElements(document, []);
    const counts = new Map();
    for (const el of everything) {
      const r = el.getAttribute && el.getAttribute("data-owl-ref");
      if (r) counts.set(r, (counts.get(r) || 0) + 1);
    }
    for (const el of everything) {
      const r = el.getAttribute && el.getAttribute("data-owl-ref");
      if (r && (counts.get(r) > 1 || !/^e\d+$/.test(r) || Number(r.slice(1)) >= a.seq)) el.removeAttribute("data-owl-ref");
    }
    const els = modal ? allElements(scope, []) : everything;
    let index = 0;
    for (const el of els) {
      index++;
      if (!el.matches || !el.matches(INTERACTIVE)) continue;
      if (el.closest && el.closest("[inert]")) continue;
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      const dist = r.bottom < 0 ? -r.bottom : r.top > vh ? r.top - vh : r.right < 0 || r.left > vw ? 1 : 0;
      cands.push({ el, r, dist, index });
    }
    // By role and name (a script's target, or the agent narrowing the list): every match on the page in document
    // order, not only those near the viewport. `*` in the name stands for any run of characters.
    const low = (v: any) => norm(v).toLowerCase();
    const wantRole = a.role ? low(a.role) : "";
    const wantName = a.name === undefined || a.name === null ? null : low(a.name);
    const nameRe =
      wantName !== null && wantName.includes("*")
        ? new RegExp("^" + wantName.split("*").map((part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s\\S]*") + "$", "u")
        : null;
    const filtered = !!wantRole || wantName !== null;
    const others: string[] = [];
    const pool = !filtered
      ? cands
      : cands.filter(({ el }) => {
          const c = classify(el);
          if (wantRole && c.role !== wantRole) return false;
          const n = low(c.name);
          const hit = wantName === null || (nameRe ? nameRe.test(n) : n === wantName);
          // What the page has instead, for the error a miss becomes.
          if (!hit && c.name && others.length < 12 && !others.includes(cut(c.name, 60))) others.push(cut(c.name, 60));
          return hit;
        });
    const total = pool.length;
    const chosen = filtered
      ? pool.slice(0, limit)
      : pool
          .slice()
          .sort((x, y) => x.dist - y.dist || x.index - y.index)
          .slice(0, limit)
          .sort((x, y) => x.index - y.index);
    const items = chosen.map(({ el, r }) => {
      const c = classify(el);
      const it: any = { ref: assignRef(el), role: c.role, name: c.name };
      if (c.tag === "input" && c.role === "textbox" && c.inputType !== "text") it.inputType = c.inputType;
      const tag = c.tag;
      if (tag === "input" || tag === "textarea") {
        const t = c.inputType;
        if (t === "checkbox" || t === "radio") it.checked = !!el.checked;
        else if (!["submit", "button", "reset", "image", "file"].includes(t)) {
          const v = String(el.value ?? "");
          if (v) it.value = isSecret(el) ? "••••••" : cut(v.replace(/\s+/g, " "), 60);
        }
      } else if (tag === "select") {
        const opts = Array.from(el.options || []);
        const sel = opts.filter((o: any) => o.selected).map((o: any) => norm(o.label || o.text));
        if (sel.length) it.value = cut(sel.join(", "), 60);
        it.options = opts.slice(0, 12).map((o: any) => cut(norm(o.label || o.text), 30));
        if (opts.length > 12) it.options.push("…+" + (opts.length - 12));
      } else if (el.isContentEditable) {
        const v = norm(el.innerText);
        if (v && v !== c.name) it.value = el.getAttribute("data-owl-secret") === "1" ? "••••••" : cut(v, 60);
      } else if (["checkbox", "switch", "radio", "menuitemcheckbox", "menuitemradio"].includes(c.role)) {
        it.checked = el.getAttribute("aria-checked") === "true";
      }
      if (c.href) it.href = shortHref(c.href);
      if (el.disabled || el.getAttribute("aria-disabled") === "true") it.disabled = true;
      if (c.submit) it.submit = true;
      if (r.bottom < 0) it.pos = "above";
      else if (r.top > vh) it.pos = "below";
      return it;
    });
    return { items, total, seq: a.seq, modal: modal ? cut(nameOf(modal), 80) || "untitled" : "", ...(filtered && !total ? { others } : {}) };
  }

  if (op === "info") {
    const headings: string[] = [];
    for (const h of document.querySelectorAll("h1, h2, h3")) {
      if (headings.length >= 12) break;
      const t = norm(h.innerText);
      if (t && visible(h)) headings.push("#".repeat(Number(h.tagName[1])) + " " + cut(t, 80));
    }
    const alerts: string[] = [];
    for (const al of document.querySelectorAll('[role="alert"], [aria-live="assertive"], .alert, .error')) {
      if (alerts.length >= 3) break;
      const t = norm(al.innerText);
      if (t && visible(al)) alerts.push(cut(t, 160));
    }
    let captcha = false;
    const capSel =
      'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], iframe[src*="challenges.cloudflare.com"], iframe[src*="captcha" i], ' +
      '.g-recaptcha, .h-captcha, .cf-turnstile, #challenge-form, #cf-challenge-running, [class*="captcha" i], [id*="captcha" i]';
    for (const c of document.querySelectorAll(capSel)) {
      if (c.closest(".grecaptcha-badge")) continue;
      const r = c.getBoundingClientRect();
      if (r.width >= 30 && r.height >= 30 && visible(c)) {
        captcha = true;
        break;
      }
    }
    // Yandex's SmartCaptcha page and Google's "unusual traffic" page.
    if (!captcha) captcha = /\/showcaptcha|\/sorry\/index/.test(location.pathname);
    if (!captcha) {
      const sample = document.title + " " + String((document.body && document.body.innerText) || "").slice(0, 1500);
      captcha = CHECK_PASSING.test(sample) || CHECK.test(sample);
    }
    const se = document.scrollingElement || document.documentElement;
    return {
      title: document.title,
      url: location.href,
      scrollY: Math.round(window.scrollY),
      scrollHeight: Math.round(se ? se.scrollHeight : 0),
      viewportHeight: window.innerHeight,
      headings,
      alerts,
      captcha,
    };
  }

  if (op === "text") {
    let root = document.body;
    const main = document.querySelector('main, [role="main"], article');
    if (main && norm(main.innerText).length > 200) root = main;
    const raw = String((root && root.innerText) || "");
    const text = raw
      .split("\n")
      .map((l: string) => l.replace(/[ \t ]+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return { text: text.slice(0, a.maxChars), total: text.length };
  }

  if (op === "results") {
    // A search engine's result list: each result's title is a heading with its link (Google <a><h3>, Bing and
    // DuckDuckGo <h2><a>, Yandex <a><h2>). The engine's own links (`own`, tested on host + path: ads, its images and
    // related searches) are left out.
    const own = new RegExp(a.own || "$^", "i");
    const out: Array<{ title: string; url: string; snippet: string }> = [];
    const seen = new Set<string>();
    for (const h of document.querySelectorAll("h2, h3")) {
      if (out.length >= a.max) break;
      const link = h.closest("a[href]") || h.querySelector("a[href]");
      if (!link || !visible(h)) continue;
      if (link.closest('[data-text-ad], .b_ad, [data-testid="ad"], [data-fast-name="ad"]')) continue;
      let url = "";
      try {
        const u = new URL(String(link.href || ""));
        let target = u.href;
        // Bing wraps results in bing.com/ck/a?…&u=a1<base64url>; Google in /url?q=<target>, or in /goto?url=<opaque>,
        // which only Google can resolve: that link is the result then (opening it leads to the page).
        const wrapped = u.searchParams.get("u") || "";
        let opaque = false;
        if (/(^|\.)bing\.com$/.test(u.hostname) && u.pathname === "/ck/a" && wrapped.startsWith("a1")) target = atob(wrapped.slice(2).replace(/-/g, "+").replace(/_/g, "/"));
        else if (/(^|\.)google\.[a-z.]+$/.test(u.hostname) && u.pathname === "/url" && /^https?:/.test(u.searchParams.get("q") || "")) target = String(u.searchParams.get("q"));
        else if (/(^|\.)google\.[a-z.]+$/.test(u.hostname) && u.pathname === "/goto") opaque = true;
        const t = new URL(target);
        if ((t.protocol !== "http:" && t.protocol !== "https:") || (!opaque && own.test(t.hostname + t.pathname))) continue;
        url = t.href;
      } catch {
        continue;
      }
      const title = cut(norm(h.innerText), 200);
      if (!title || seen.has(url)) continue;
      seen.add(url);
      // The result's block: the widest ancestor that still holds only this heading.
      let block = "";
      for (let el = h.parentElement, i = 0; el && el !== document.body && i < 10; el = el.parentElement, i++) {
        if (el.querySelectorAll("h2, h3").length > 1) break;
        block = norm(el.innerText);
      }
      out.push({ title, url, snippet: cut(norm(block.replace(title, " ")), 300) });
    }
    return out;
  }

  if (op === "classify") {
    const el = byRef(a.ref);
    if (!el) return null;
    return classify(el);
  }

  if (op === "focus") {
    // document.hasFocus() is not used on purpose: a headed window without OS focus would report false.
    const el = deepActive();
    if (!el || el === document.body || el === document.documentElement) return { none: true };
    if (el.tagName === "IFRAME" || el.tagName === "FRAME") return { frame: true };
    const c = classify(el);
    return { ref: assignRef(el), seq: a.seq, tag: c.tag, name: c.name, editable: c.editable, inForm: c.inForm, search: c.search, submit: c.submit, reason: c.reason };
  }

  if (op === "markSecret") {
    const el = byRef(a.ref);
    if (!el) return false;
    el.setAttribute("data-owl-secret", "1");
    if (String(el.type || "").toLowerCase() !== "password") el.style.setProperty("-webkit-text-security", "disc", "important");
    return true;
  }

  if (op === "scroll") {
    const se = document.scrollingElement || document.documentElement;
    return { x: Math.round(window.scrollX), y: Math.round(window.scrollY), h: Math.round(se.scrollHeight), vh: window.innerHeight, w: Math.round(se.scrollWidth), vw: window.innerWidth };
  }

  if (op === "scrollBy") {
    window.scrollBy(a.dx, a.dy);
    return true;
  }

  // ---------- what the person acts on in the live view (the recorder; run in our isolated world, no refs set) ----------
  /** What is typed here must never be recorded: passwords, one-time codes, card numbers and their codes. */
  function neverRecord(el: any) {
    if (isSecret(el)) return true;
    const ac = String(el.getAttribute("autocomplete") || "").toLowerCase();
    if (/\b(one-time-code|current-password|new-password|cc-number|cc-csc|cc-exp|cc-exp-month|cc-exp-year)\b/.test(ac)) return true;
    const hint = [el.getAttribute("name"), el.id, el.getAttribute("aria-label"), el.getAttribute("placeholder"), nameOf(el)].map(words).join(" ");
    // Russian: "код из СМС", "код подтверждения", "номер карты".
    return /\b(otp|one ?time|cvv|cvc|csc|card ?number|pin ?code|sms ?code)\b|код из|код подтвержд|номер карты/i.test(hint);
  }
  function describe(el: any) {
    const target = el.tagName === "LABEL" && el.control ? el.control : el;
    const ctrl = (target.closest && target.closest(INTERACTIVE)) || target;
    const c = classify(ctrl);
    const interactive = !!(ctrl.matches && ctrl.matches(INTERACTIVE));
    const editable = isEditable(ctrl);
    return {
      role: interactive || editable ? c.role : "text",
      name: interactive || editable ? c.name : cut(norm(ctrl.innerText || ctrl.textContent), 80),
      ...(c.href ? { href: shortHref(c.href) } : {}),
      ...(editable ? { editable: true } : {}),
      ...(editable && neverRecord(ctrl) ? { secret: true } : {}),
      ...(c.submit ? { submit: true } : {}),
    };
  }
  /** The element at a point (CSS px), through open shadow roots and frames of this site; a frame of another site by name. */
  function deepAt(x: number, y: number) {
    let doc = document;
    for (let depth = 0; depth < 8; depth++) {
      let el = doc.elementFromPoint(x, y);
      while (el && el.shadowRoot) {
        const inner = el.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === el) break;
        el = inner;
      }
      if (!el) return null;
      if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
        let inner = null;
        try {
          inner = el.contentDocument;
        } catch {
          /* another site */
        }
        if (!inner) {
          let host = "";
          try {
            host = new URL(el.src, location.href).host;
          } catch {
            /* no address */
          }
          return { frame: host || "another site" };
        }
        const r = el.getBoundingClientRect();
        x -= r.left + el.clientLeft;
        y -= r.top + el.clientTop;
        doc = inner;
        continue;
      }
      return { el };
    }
    return null;
  }

  if (op === "at") {
    const hit = deepAt(a.x, a.y);
    if (!hit) return null;
    if ("frame" in hit) return { role: "frame", name: "", frame: hit.frame };
    return describe(hit.el);
  }

  if (op === "field") {
    const el = deepActive();
    if (!el || el === document.body || el === document.documentElement) return null;
    if (el.tagName === "IFRAME" || el.tagName === "FRAME") return { role: "frame", name: "", frame: "embedded" };
    const d = describe(el);
    if (!d.editable) return d;
    const value = el.isContentEditable ? norm(el.innerText) : String(el.value ?? "");
    return d.secret ? d : { ...d, value: cut(value, 500) };
  }

  if (op === "area") {
    // What is inside a frame the person drew: its text, and the controls there.
    const x0 = Math.min(a.x0, a.x1);
    const x1 = Math.max(a.x0, a.x1);
    const y0 = Math.min(a.y0, a.y1);
    const y1 = Math.max(a.y0, a.y1);
    const slack = 4;
    const inside = (r: any) => r.width >= 1 && r.height >= 1 && r.left >= x0 - slack && r.right <= x1 + slack && r.top >= y0 - slack && r.bottom <= y1 + slack;
    const all = allElements(document, []).filter((el: any) => el.getBoundingClientRect && visible(el));
    const within = all.filter((el: any) => inside(el.getBoundingClientRect()));
    const set = new Set(within);
    // The outermost elements inside the frame carry its text once.
    const tops = within.filter((el: any) => !(el.parentElement && set.has(el.parentElement)));
    let text = tops
      .map((el: any) => norm(el.innerText || el.textContent))
      .filter(Boolean)
      .join(" · ");
    if (!text) {
      // The frame sits inside one element (a part of a long paragraph): that element's text.
      const hit = deepAt((x0 + x1) / 2, (y0 + y1) / 2);
      if (hit && "el" in hit) text = norm(hit.el.innerText || hit.el.textContent);
    }
    const controls: any[] = [];
    for (const el of all) {
      if (controls.length >= 15 || !el.matches(INTERACTIVE)) continue;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cx < x0 || cx > x1 || cy < y0 || cy > y1) continue;
      const d = describe(el);
      if (d.name) controls.push({ role: d.role, name: d.name });
    }
    return { text: cut(text, 1500), controls };
  }

  throw new Error("unknown page op " + op);
}

const SRC = `(${pageScript.toString()})`;

/** Expression for frame.evaluate(): runs `op` with JSON-serializable args. */
export function pageCall(op: string, args: Record<string, unknown> = {}): string {
  return `${SRC}(${JSON.stringify(op)}, ${JSON.stringify(args)})`;
}
