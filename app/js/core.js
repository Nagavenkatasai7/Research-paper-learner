/* Paper Quest — core: DOM helpers, platform services, storage and the Claude wrapper.
 * Every module hangs off the global `PQ` namespace (classic scripts, no bundler). */
"use strict";
window.PQ = window.PQ || {};

(function (PQ) {
  /* ---------------- DOM + text helpers ---------------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

  /** Build one element from an HTML string. Interpolate user or model text only through esc(). */
  function el(html) {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }
  const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clone = (o) => JSON.parse(JSON.stringify(o ?? null));
  const str = (x, fallback = "") => (typeof x === "string" ? x.trim() : x == null ? fallback : String(x).trim());
  const arr = (x) => (Array.isArray(x) ? x : []);

  const encoder = new TextEncoder();
  const byteLen = (s) => encoder.encode(s).length;
  /** Trim a string so its UTF-8 size stays under maxBytes. */
  function clipBytes(s, maxBytes) {
    s = String(s || "");
    if (maxBytes <= 0) return "";
    if (byteLen(s) <= maxBytes) return s;
    let lo = 0;
    let hi = Math.min(s.length, maxBytes);
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (byteLen(s.slice(0, mid)) <= maxBytes) lo = mid;
      else hi = mid - 1;
    }
    return s.slice(0, lo);
  }

  /** Small, safe Markdown subset for Pip's free-text answers. */
  function md(src) {
    const inline = (t) =>
      esc(t)
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>");
    let out = "";
    let para = [];
    let list = null;
    const flushP = () => {
      if (para.length) out += `<p>${inline(para.join(" "))}</p>`;
      para = [];
    };
    const flushL = () => {
      if (list) out += `<${list.t}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.t}>`;
      list = null;
    };
    for (const raw of String(src || "").replace(/\r/g, "").split("\n")) {
      const line = raw.trim();
      let m;
      if (!line) {
        flushP();
        flushL();
      } else if ((m = line.match(/^#{1,6}\s+(.*)/))) {
        flushP();
        flushL();
        out += `<h4>${inline(m[1])}</h4>`;
      } else if ((m = line.match(/^[-*•]\s+(.*)/))) {
        flushP();
        if (!list || list.t !== "ul") {
          flushL();
          list = { t: "ul", items: [] };
        }
        list.items.push(m[1]);
      } else if ((m = line.match(/^\d+[.)]\s+(.*)/))) {
        flushP();
        if (!list || list.t !== "ol") {
          flushL();
          list = { t: "ol", items: [] };
        }
        list.items.push(m[1]);
      } else {
        flushL();
        para.push(line);
      }
    }
    flushP();
    flushL();
    return out;
  }

  /* ---------------- SVG sanitizing (drawings come from the model) ---------------- */
  const SVG_DROP = new Set(["script", "foreignobject", "iframe", "image", "style", "a", "animate", "animatemotion", "animatetransform", "set", "audio", "video", "object", "embed", "link", "meta"]);
  function sanitizeSvg(raw, label) {
    let s = String(raw || "");
    const a = s.indexOf("<svg");
    const b = s.lastIndexOf("</svg>");
    if (a < 0 || b < 0) return null;
    s = s.slice(a, b + 6);
    const doc = new DOMParser().parseFromString(s, "image/svg+xml");
    const root = doc.documentElement;
    if (!root || root.nodeName.toLowerCase() !== "svg" || doc.getElementsByTagName("parsererror").length) return null;
    const walk = (node) => {
      for (const child of Array.from(node.children)) {
        if (SVG_DROP.has(child.nodeName.toLowerCase())) {
          child.remove();
          continue;
        }
        for (const attr of Array.from(child.attributes)) {
          const name = attr.name.toLowerCase();
          const val = attr.value;
          const bad =
            name.startsWith("on") ||
            ((name === "href" || name === "xlink:href") && !val.startsWith("#")) ||
            /javascript:|data:/i.test(val) ||
            /url\(\s*['"]?(?!#)/i.test(val);
          if (bad) child.removeAttribute(attr.name);
        }
        walk(child);
      }
    };
    for (const attr of Array.from(root.attributes)) {
      if (attr.name.toLowerCase().startsWith("on")) root.removeAttribute(attr.name);
    }
    walk(root);
    if (!root.getAttribute("viewBox")) root.setAttribute("viewBox", "0 0 640 360");
    root.removeAttribute("width");
    root.removeAttribute("height");
    root.setAttribute("preserveAspectRatio", "xMidYMid meet");
    root.setAttribute("role", "img");
    if (label) root.setAttribute("aria-label", label);
    return document.importNode(root, true);
  }

  /* ---------------- Platform services ---------------- */
  const svc = {
    inViewer: !!(window.claude && typeof window.claude.use === "function"),
    sample: null,
    db: null,
    assets: null,
    user: null,
    uid: null,
    images: false,
    maxBytes: 65536,
  };

  async function connect() {
    if (!svc.inViewer) {
      // Outside claude.ai, Pip can think through the viewer's own OpenRouter key, if they saved one.
      const cfg = PQ.openrouter && PQ.openrouter.load();
      if (cfg && cfg.key) PQ.openrouter.activate(cfg);
      return;
    }
    const use = (name) =>
      Promise.resolve()
        .then(() => window.claude.use(name))
        .catch(() => null);
    const [sample, db, assets, user] = await Promise.all([use("sample"), use("db"), use("assets"), use("user")]);
    Object.assign(svc, { sample, db, assets, user });
    if (user) {
      try {
        svc.uid = await user.id();
      } catch (e) {
        svc.uid = null;
      }
    }
    if (sample) {
      try {
        const lim = await sample.limits();
        svc.images = !!(lim && lim.images);
        svc.maxBytes = (lim && lim.maxPromptBytes) || 65536;
      } catch (e) {
        svc.images = false;
      }
    }
  }

  /* ---------------- Local storage (IndexedDB, with in-memory fallback) ---------------- */
  const idb = (() => {
    const mem = { docs: new Map(), blobs: new Map() };
    let dbp = null;
    function open() {
      if (!dbp) {
        dbp = new Promise((resolve, reject) => {
          try {
            const req = indexedDB.open("paper-quest", 1);
            req.onupgradeneeded = () => {
              req.result.createObjectStore("docs");
              req.result.createObjectStore("blobs");
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          } catch (e) {
            reject(e);
          }
        });
      }
      return dbp;
    }
    function run(store, mode, fn) {
      return open().then(
        (d) =>
          new Promise((resolve, reject) => {
            const tx = d.transaction(store, mode);
            const req = fn(tx.objectStore(store));
            tx.oncomplete = () => resolve(req ? req.result : undefined);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
          })
      );
    }
    return {
      async get(store, key) {
        try {
          return await run(store, "readonly", (s) => s.get(key));
        } catch (e) {
          return mem[store].get(key);
        }
      },
      async put(store, key, val) {
        mem[store].set(key, val);
        try {
          await run(store, "readwrite", (s) => s.put(val, key));
        } catch (e) {
          /* memory copy is enough for this visit */
        }
      },
      async del(store, key) {
        mem[store].delete(key);
        try {
          await run(store, "readwrite", (s) => s.delete(key));
        } catch (e) {
          /* ignore */
        }
      },
      async entries(store) {
        try {
          const d = await open();
          return await new Promise((resolve, reject) => {
            const out = [];
            const req = d.transaction(store, "readonly").objectStore(store).openCursor();
            req.onsuccess = () => {
              const c = req.result;
              if (c) {
                out.push([c.key, c.value]);
                c.continue();
              } else resolve(out);
            };
            req.onerror = () => reject(req.error);
          });
        } catch (e) {
          return Array.from(mem[store].entries());
        }
      },
    };
  })();

  /* Serialize writes per path: one write at a time per document, latest data wins. */
  const pending = new Map();
  function serialWrite(path, write) {
    const prev = pending.get(path) || Promise.resolve();
    const next = prev.catch(() => {}).then(write);
    pending.set(path, next);
    next.finally(() => {
      if (pending.get(path) === next) pending.delete(path);
    });
    return next;
  }

  const LocalStore = {
    kind: "local",
    async list() {
      const all = await idb.entries("docs");
      return all.filter(([k]) => /^paper\//.test(k)).map(([, v]) => v);
    },
    get: (id) => idb.get("docs", `paper/${id}`),
    put: (paper) => serialWrite(`paper/${paper.id}`, () => idb.put("docs", `paper/${paper.id}`, clone(paper))),
    getPart: (id, name) => idb.get("docs", `part/${id}/${name}`),
    putPart: (id, name, data) => serialWrite(`part/${id}/${name}`, () => idb.put("docs", `part/${id}/${name}`, clone(data))),
    async remove(id) {
      for (const name of PART_NAMES) await idb.del("docs", `part/${id}/${name}`);
      await idb.del("docs", `paper/${id}`);
    },
  };

  /* Claude-hosted store: each viewer's own private subtree data/users/<uid>/... */
  const DbStore = {
    kind: "db",
    col() {
      return svc.db.collection(`data/users/${svc.uid}`);
    },
    partRef(id, name) {
      return this.col().doc(id).collection("parts").doc(name);
    },
    async list() {
      const snap = await this.col().get();
      return snap.docs.filter((d) => d.id.startsWith("p_")).map((d) => d.data());
    },
    async get(id) {
      const s = await this.col().doc(id).get();
      return s.exists ? clone(s.data()) : null;
    },
    put(paper) {
      const ref = this.col().doc(paper.id);
      return serialWrite(ref.path, () => ref.set(clone(paper)));
    },
    async getPart(id, name) {
      const s = await this.partRef(id, name).get();
      return s.exists ? clone(s.data()) : null;
    },
    putPart(id, name, data) {
      const ref = this.partRef(id, name);
      return serialWrite(ref.path, () => ref.set(clone(data)));
    },
    async remove(id) {
      for (const name of PART_NAMES) await this.partRef(id, name).delete();
      await this.col().doc(id).delete();
    },
  };

  const PART_NAMES = ["story", "map", "read", "xray", "teach", "brainstorm"];

  const store = {
    impl: LocalStore,
    choose() {
      this.impl = svc.db && svc.uid ? DbStore : LocalStore;
    },
    get synced() {
      return this.impl === DbStore;
    },
    list: () => store.impl.list(),
    get: (id) => store.impl.get(id),
    put: (p) => store.impl.put(p),
    getPart: (id, n) => store.impl.getPart(id, n),
    putPart: (id, n, d) => store.impl.putPart(id, n, d),
    remove: (id) => store.impl.remove(id),

    /** Keep the PDF on this device and, when possible, in the artifact's asset store. */
    async savePdf(paperId, blob) {
      await idb.put("blobs", paperId, blob);
      if (svc.assets && blob.size < 20 * 1024 * 1024) {
        try {
          const r = await svc.assets.upload(blob, { type: "application/pdf" });
          return r.id;
        } catch (e) {
          console.warn("PDF upload failed; keeping it on this device only", e);
        }
      }
      return null;
    },
    async loadPdf(paper) {
      let blob = await idb.get("blobs", paper.id);
      if (!blob && paper.pdfAsset) {
        try {
          const r = await fetch(`/_blob/${paper.pdfAsset}`);
          if (r.ok) {
            blob = await r.blob();
            idb.put("blobs", paper.id, blob);
          }
        } catch (e) {
          console.warn("Could not fetch the stored PDF", e);
        }
      }
      return blob || null;
    },
    async dropPdf(paper) {
      await idb.del("blobs", paper.id);
      if (paper.pdfAsset && svc.assets) {
        try {
          await svc.assets.delete(paper.pdfAsset);
        } catch (e) {
          console.warn("Could not delete stored PDF", e);
        }
      }
    },
  };

  /* ---------------- Talking to Claude ---------------- */
  const PIP_VOICE = [
    'You are Pip, a friendly little robot tutor inside the "Paper Quest" app.',
    "The learner is new to research and reads AI/ML papers. Explain like they are 5: short sentences, everyday analogies, no unexplained jargon.",
    "Stay faithful to the paper. Never invent results, numbers, or claims. If the paper does not say something, say so.",
  ].join(" ");

  const FRIENDLY = {
    no_sample: "Pip has no brain connected here. Open Paper Quest from claude.ai, or add a free OpenRouter key in the library.",
    bad_key: "OpenRouter didn't accept that key. Check it on openrouter.ai/keys and connect again.",
    no_credit: "OpenRouter says this account needs credit for that request. Pick another free model in Pip's brain.",
    model_unavailable: "That free model isn't available right now. Pick another one in Pip's brain.",
    not_granted: "This page isn't allowed to use Claude yet. Reload the page and choose Allow when Claude asks.",
    sampling_disabled: "Claude isn't available for this account, so Pip can't think here.",
    rate_limited: "Pip needs a breather: you've hit a usage limit or sent too many requests at once. Free models allow only a few requests a minute. Wait a little, then try again.",
    session_expired: "Your Claude session expired. Sign in again, then reload this page.",
    prompt_too_large: "That was too much text for one go. Try a smaller piece.",
    refused: "Claude declined that request. Try asking in a different way.",
    invalid_json: "Pip's answer came out jumbled. Try again.",
    empty_completion: "Pip came back with nothing. Try again.",
    images_unavailable: "Pip can't look at images here, so it used the page's text instead.",
    cancelled: "Stopped.",
  };

  class AIError extends Error {
    constructor(code, text) {
      super(FRIENDLY[code] || "Pip couldn't reach Claude just now. Try again in a moment.");
      this.code = code;
      this.partial = text;
    }
  }

  /**
   * Build a prompt from fixed text and flexible blocks, trimming the flexible ones
   * so the whole request stays under the platform's per-call byte limit.
   * blocks: string | {label, text, flex: true}
   */
  function buildPrompt(task, blocks) {
    const budget = Math.max(8000, (svc.maxBytes || 65536) - 2500);
    const head = `TASK: ${task}\n\n${PIP_VOICE}\n\n`;
    const fixed = blocks.filter((b) => typeof b === "string");
    const flex = blocks.filter((b) => b && typeof b === "object");
    let used = byteLen(head) + fixed.reduce((n, b) => n + byteLen(b) + 2, 0) + flex.reduce((n, b) => n + byteLen(b.label) + 8, 0);
    let remaining = budget - used;
    const sized = new Map();
    const bySize = [...flex].sort((a, b) => byteLen(a.text || "") - byteLen(b.text || ""));
    bySize.forEach((b, i) => {
      const share = Math.floor(remaining / (bySize.length - i));
      const text = clipBytes(b.text || "", share);
      sized.set(b, text);
      remaining -= byteLen(text);
    });
    const body = blocks
      .map((b) => (typeof b === "string" ? b : `${b.label}:\n"""\n${sized.get(b) || "(none)"}\n"""`))
      .join("\n\n");
    return head + body;
  }

  /**
   * Ask Claude through the viewer's own account.
   * json: parse the reply as JSON. tier: "quick" | "default" | "complex".
   * fresh: skip the 5-minute answer cache (chat turns, "try again").
   */
  async function ask({ task, blocks, json = true, tier = "default", onText, images, signal, fresh = false }) {
    if (!svc.sample) throw new AIError("no_sample");
    const prompt = buildPrompt(task, blocks);
    const opts = { modelTier: tier };
    if (fresh) opts.cache = false;
    if (onText) opts.onText = onText;
    if (signal) opts.signal = signal;
    if (images && svc.images) opts.images = images;
    try {
      if (json) return await svc.sample.json(prompt, opts);
      const r = await svc.sample(prompt, opts);
      return r.text;
    } catch (e) {
      throw new AIError((e && e.code) || "upstream_error", e && e.text);
    }
  }

  /** An error line with a retry button, shared by every stage. */
  function errorBox(err, retry) {
    const box = el(`<div class="err" role="alert"><span>${esc(err && err.message ? err.message : String(err))}</span></div>`);
    if (retry && !(err && ["not_granted", "sampling_disabled", "no_sample"].includes(err.code))) {
      const b = el(`<button class="btn small" type="button">Try again</button>`);
      b.addEventListener("click", retry);
      box.appendChild(b);
    }
    return box;
  }

  let toastTimer = null;
  function toast(message, action) {
    document.querySelectorAll(".toast").forEach((t) => t.remove());
    const t = el(`<div class="toast" role="status"><span>${esc(message)}</span></div>`);
    if (action) {
      const b = el(`<button class="btn small" type="button">${esc(action.label)}</button>`);
      b.addEventListener("click", () => {
        t.remove();
        action.run();
      });
      t.appendChild(b);
    }
    document.body.appendChild(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), action ? 9000 : 4000);
  }

  Object.assign(PQ, {
    $,
    $$,
    esc,
    el,
    clear,
    newId,
    sleep,
    clone,
    str,
    arr,
    byteLen,
    clipBytes,
    md,
    sanitizeSvg,
    svc,
    connect,
    store,
    ask,
    AIError,
    errorBox,
    toast,
    PIP_VOICE,
  });
})(window.PQ);
