/* Paper Quest — OpenRouter brain for copies hosted outside claude.ai (e.g. the Vercel site).
 * The viewer pastes their own OpenRouter key; it is kept in this browser's localStorage and sent
 * only to openrouter.ai. The adapter exposes the same call shape as claude.ai's `sample`
 * capability, so every stage works unchanged. Only free models are offered. */
"use strict";
(function (PQ) {
  const API = "https://openrouter.ai/api/v1";
  const STORE_KEY = "pq:openrouter";
  const CFG_VERSION = 2;
  const ROUTER = "openrouter/free"; // OpenRouter's free router: picks any free model that supports the request (images, JSON)
  // Strong general free models first (as of Sep 2026); the list changes often, so unknown names still work.
  const PREFER = [/nemotron-?3-?ultra|nemotron.*ultra/i, /qwen3(?!.*coder)/i, /llama-4|llama-3\.3-70b/i, /gpt-oss-120b/i, /deepseek/i, /gemma-3-27b|gemma/i, /mistral|mixtral/i, /gpt-oss/i];
  // Weaker for teaching (tiny, coding-only, or anonymous "alpha" test models): keep them last.
  const DEMOTE = /coder|alpha|nano(?!.*vl)|mini|small|lfm|liquid|(^|[^0-9.])[1-8]b\b/i;
  // Free models that only serve approved agent apps, never a web page like this one.
  const EXCLUDE = /inkling/i;
  const rank = (m) => {
    if (DEMOTE.test(m.id)) return PREFER.length + 1;
    const i = PREFER.findIndex((re) => re.test(m.id));
    return i < 0 ? PREFER.length : i;
  };
  const visionRank = (m) => (/nemotron.*vl|vl\b|vision/i.test(m.id) ? 0 : /gemma|llama-4|qwen/i.test(m.id) ? 1 : 2);

  function load() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    } catch (e) {
      return null;
    }
  }
  function save(cfg) {
    try {
      if (cfg) localStorage.setItem(STORE_KEY, JSON.stringify(cfg));
      else localStorage.removeItem(STORE_KEY);
    } catch (e) {
      /* private window: the key lasts for this visit only */
    }
  }

  let modelsCache = null;
  /** Free models with enough context for Paper Quest's prompts, best first. */
  async function freeModels() {
    if (modelsCache) return modelsCache;
    const r = await fetch(`${API}/models`);
    if (!r.ok) throw new Error("Couldn't load OpenRouter's model list. Check your connection and try again.");
    const j = await r.json();
    modelsCache = PQ.arr(j && j.data)
      .filter((m) => m.id !== ROUTER && !EXCLUDE.test(m.id))
      .filter((m) => /:free$/.test(m.id) || (m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0))
      .map((m) => {
        const arch = m.architecture || {};
        const inputs = PQ.arr(arch.input_modalities);
        const params = PQ.arr(m.supported_parameters);
        return {
          id: m.id,
          name: m.name || m.id,
          context: Number(m.context_length) || 0,
          vision: inputs.includes("image") || /image/.test(arch.modality || ""),
          json: params.includes("response_format") || params.includes("structured_outputs"),
          maxOut: Number(m.top_provider && m.top_provider.max_completion_tokens) || 0,
        };
      })
      .filter((m) => m.context >= 16000)
      .sort((a, b) => rank(a) - rank(b) || b.context - a.context);
    return modelsCache;
  }

  const blobToDataUrl = (b) =>
    new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(b);
    });

  const stripThink = (s) => s.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").replace(/^\s+/, "");

  function fail(code, message, extra) {
    return Object.assign({ code, message: message || code, detail: message || "" }, extra || {});
  }

  /** Tidy a pasted key: drop spaces, line breaks, quotes and a leading "Bearer". */
  function cleanKey(raw) {
    return String(raw || "")
      .replace(/\s+/g, "")
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(/^Bearer/i, "");
  }

  /** Ask OpenRouter about the key itself, separately from any model. */
  async function checkKey(key) {
    for (const endpoint of ["/key", "/auth/key"]) {
      let r;
      try {
        r = await fetch(`${API}${endpoint}`, { headers: { Authorization: `Bearer ${key}` } });
      } catch (e) {
        throw fail("upstream_error", "Couldn't reach openrouter.ai from this browser. Check your connection, or an ad or privacy blocker.");
      }
      if (r.status === 404) continue;
      let body = null;
      try {
        body = await r.json();
      } catch (e) {
        body = null;
      }
      if (r.ok) return (body && body.data) || {};
      const msg = (body && body.error && body.error.message) || `HTTP ${r.status}`;
      throw fail(r.status === 401 || r.status === 403 ? "bad_key" : "upstream_error", msg);
    }
    return {};
  }

  /** Request settings per model: room for long study notes, JSON mode where supported, steady answers. */
  function requestBody(cfg, model, content, opts) {
    const caps = (cfg.caps && cfg.caps[model]) || {};
    const body = { model, stream: true, messages: [{ role: "user", content }] };
    body.max_tokens = Math.min(8192, caps.maxOut || 8192);
    if (opts.json) {
      body.temperature = 0.3;
      if (caps.json || model === ROUTER) body.response_format = { type: "json_object" };
    } else body.temperature = 0.7;
    return body;
  }

  async function streamOnce(cfg, model, content, opts) {
    let r;
    try {
      r = await fetch(`${API}/chat/completions`, {
        method: "POST",
        signal: opts.signal,
        headers: {
          Authorization: `Bearer ${cfg.key}`,
          "Content-Type": "application/json",
          "HTTP-Referer": location.origin,
          "X-Title": "Paper Quest",
        },
        body: JSON.stringify(requestBody(cfg, model, content, opts)),
      });
    } catch (e) {
      if (e && e.name === "AbortError") throw fail("cancelled");
      throw fail("upstream_error", "Couldn't reach OpenRouter.");
    }
    if (!r.ok) {
      let msg = "";
      try {
        msg = ((await r.json()).error || {}).message || "";
      } catch (e) {
        msg = "";
      }
      const code =
        r.status === 401 ? "bad_key" : r.status === 403 ? "forbidden" : r.status === 402 ? "no_credit" : r.status === 429 ? "rate_limited" : r.status === 404 ? "model_unavailable" : r.status === 400 && /context|too long|maximum|tokens/i.test(msg) ? "prompt_too_large" : "upstream_error";
      throw fail(code, msg);
    }

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let full = "";
    let shown = "";
    let truncated = false;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue; // SSE comments such as ": OPENROUTER PROCESSING"
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          let j;
          try {
            j = JSON.parse(data);
          } catch (e) {
            continue;
          }
          if (j.error) throw fail(j.error.code === 429 ? "rate_limited" : "upstream_error", j.error.message, { text: stripThink(full), started: !!full });
          const choice = (j.choices || [])[0] || {};
          const delta = (choice.delta && choice.delta.content) || "";
          if (choice.finish_reason === "length") truncated = true;
          if (!delta) continue;
          full += delta;
          const visible = stripThink(full);
          if (visible && visible !== shown && opts.onText) {
            try {
              opts.onText({ text: visible, delta: visible.slice(shown.length) });
            } catch (e) {
              console.warn(e);
            }
          }
          shown = visible;
        }
      }
    } catch (e) {
      if (e && e.name === "AbortError") throw fail("cancelled", "", { text: stripThink(full) });
      if (e && e.code) throw e;
      throw fail("upstream_error", "The connection to OpenRouter dropped.", { text: stripThink(full), started: !!full });
    }
    const text = stripThink(full).trim();
    if (!text) throw fail("empty_completion");
    return { text, truncated, modelTierApplied: "default" };
  }

  /** Read the first JSON value out of a reply (whole reply, a code fence, or first bracket to last). */
  function parseJson(text) {
    const tries = [text];
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) tries.push(fence[1]);
    const a = text.search(/[[{]/);
    const b = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
    if (a >= 0 && b > a) tries.push(text.slice(a, b + 1));
    for (const t of tries) {
      try {
        return JSON.parse(t);
      } catch (e) {
        /* next */
      }
    }
    throw fail("invalid_json", "", { text });
  }

  // Codes that mean "this model won't serve this app": skip it for good rather than retry it.
  const REFUSED = ["forbidden", "model_unavailable", "no_credit"];

  /** A model refused to serve us: stop using it and keep the one that answered. */
  function promote(cfg, refused, working, forVision) {
    if (refused === ROUTER) return;
    cfg.bad = [...new Set([...PQ.arr(cfg.bad), refused])];
    cfg.fallbacks = PQ.arr(cfg.fallbacks).filter((m) => m !== refused && m !== working);
    if (forVision) cfg.visionModel = working === ROUTER ? ROUTER : null; // the router picks an image-capable model itself
    else {
      cfg.model = working;
      cfg.modelName = (cfg.names && cfg.names[working]) || working;
    }
    save(cfg);
    activate(cfg);
    if (PQ.refreshBanner) PQ.refreshBanner();
    const was = (cfg.names && cfg.names[refused]) || refused;
    PQ.toast(forVision ? `${was} isn't available to apps like this one, so Pip will explain pages from their text.` : `${was} isn't available to apps like this one, so Pip switched to ${cfg.modelName}.`);
  }

  /** A `sample`-compatible function backed by OpenRouter. */
  function makeSample(cfg) {
    async function sample(input, opts = {}) {
      const text = typeof input === "string" ? input : input.map((t) => t.content).join("\n\n");
      const imgs = opts.images ? (Array.isArray(opts.images) ? opts.images : Array.from(opts.images.length != null ? opts.images : [opts.images])) : [];
      const useVision = imgs.length && cfg.visionModel;
      let content = text;
      if (useVision) content = [{ type: "text", text }, ...(await Promise.all(imgs.map(async (b) => ({ type: "image_url", image_url: { url: await blobToDataUrl(b) } }))))];
      const first = useVision ? cfg.visionModel : cfg.model;
      const order = (useVision ? [first, ROUTER, cfg.model, ...PQ.arr(cfg.fallbacks)] : [first, ...PQ.arr(cfg.fallbacks), ROUTER]).filter(
        (m, i, all) => m && all.indexOf(m) === i && !PQ.arr(cfg.bad).includes(m)
      );
      let lastErr;
      for (const model of order) {
        // Only the vision model and the free router get the page image; other fallbacks get the text.
        const body = useVision && (model === first || model === ROUTER) ? content : text;
        try {
          const result = await streamOnce(cfg, model, body, opts);
          if (lastErr && REFUSED.includes(lastErr.code)) promote(cfg, order[0], model, useVision);
          return result;
        } catch (e) {
          lastErr = e;
          const retryable = [...REFUSED, "rate_limited", "upstream_error", "empty_completion"].includes(e.code) && !e.started;
          if (!retryable) throw e;
        }
      }
      throw lastErr;
    }
    sample.json = async (input, opts) => {
      const r = await sample(input, { ...(opts || {}), json: true });
      if (r.truncated) throw fail("invalid_json", "", { text: r.text });
      return parseJson(r.text);
    };
    sample.limits = async () => ({
      maxPromptBytes: cfg.maxBytes || 65536,
      images: cfg.visionModel ? { maxCount: 4, maxInputBytes: 20e6, mediaTypes: ["image/jpeg", "image/png"] } : undefined,
    });
    return sample;
  }

  /** Point Pip's brain at OpenRouter for this visit. */
  function activate(cfg) {
    PQ.svc.sample = makeSample(cfg);
    PQ.svc.provider = { name: "OpenRouter", model: cfg.modelName || cfg.model };
    PQ.svc.images = !!cfg.visionModel;
    PQ.svc.maxBytes = cfg.maxBytes || 65536;
  }
  function deactivate() {
    PQ.svc.sample = null;
    PQ.svc.provider = null;
    PQ.svc.images = false;
    save(null);
  }

  /** Check the key, then save and activate it with the chosen free model. */
  async function connect(rawKey, chosenModelId, onStatus) {
    const key = cleanKey(rawKey);
    if (!/^sk-or-/.test(key)) throw fail("bad_key", "An OpenRouter key starts with “sk-or-”. Copy the whole key from openrouter.ai/keys.");
    await checkKey(key);
    const models = await freeModels();
    if (!models.length) throw new Error("OpenRouter isn't offering any free models right now. Try again later.");
    // Some free models only serve approved agent apps, and others are busy. Try each candidate
    // with a tiny message and keep the first that actually answers.
    const chosen = models.find((m) => m.id === chosenModelId);
    const candidates = [...(chosen ? [chosen] : []), ...models.filter((m) => m !== chosen)].slice(0, 8);
    const probeCfg = { key };
    const bad = [];
    let main = null;
    let lastErr = null;
    for (const m of candidates) {
      if (onStatus) onStatus(`Trying ${m.name}…`);
      try {
        await streamOnce(probeCfg, m.id, "Reply with the single word OK.", {});
        main = m;
        break;
      } catch (e) {
        if (e.code === "bad_key") throw e;
        lastErr = e;
        bad.push(m.id);
      }
    }
    if (!main) {
      // Every candidate refused: fall back to the free router, which picks whatever free model is serving.
      try {
        await streamOnce(probeCfg, ROUTER, "Reply with the single word OK.", {});
        main = { id: ROUTER, name: "OpenRouter's free router", context: 64000, vision: true };
      } catch (e) {
        throw lastErr || e;
      }
    }
    const usable = models.filter((m) => !bad.includes(m.id));
    const visionModels = usable.filter((m) => m.vision).sort((a, b) => visionRank(a) - visionRank(b) || rank(a) - rank(b));
    const vision = main.vision ? main : visionModels[0];
    const cfg = {
      v: CFG_VERSION,
      key,
      model: main.id,
      modelName: main.name,
      visionModel: vision ? vision.id : ROUTER,
      fallbacks: usable.filter((m) => m !== main).slice(0, 3).map((m) => m.id),
      bad,
      names: { ...Object.fromEntries(models.map((m) => [m.id, m.name])), [ROUTER]: "OpenRouter's free router" },
      caps: Object.fromEntries(models.map((m) => [m.id, { json: m.json, maxOut: m.maxOut }])),
      // Leave room for the reply: roughly 3 bytes of prompt text per token, capped at the app's usual size.
      maxBytes: Math.max(12000, Math.min(65536, Math.floor(main.context * 0.6 * 3))),
    };
    cfg.note = chosen && chosen !== main ? `${chosen.name} isn't available to apps like this one, so Pip picked ${main.name}.` : "";
    save(cfg);
    activate(cfg);
    return cfg;
  }

  /** Saved setups from before model probing get re-checked once, quietly. */
  function upgradeIfNeeded(cfg) {
    if (!cfg || !cfg.key || cfg.v === CFG_VERSION) return;
    connect(cfg.key, EXCLUDE.test(cfg.model) ? "" : cfg.model)
      .then((fresh) => {
        if (PQ.refreshBanner) PQ.refreshBanner();
        PQ.toast(`Pip's brain is now ${fresh.modelName}.`);
      })
      .catch((e) => console.warn("Couldn't re-check the saved OpenRouter setup", e));
  }

  PQ.openrouter = { load, save, freeModels, connect, activate, deactivate, cleanKey, upgradeIfNeeded };
})(window.PQ);
