/* Paper Quest — OpenRouter brain for copies hosted outside claude.ai (e.g. the Vercel site).
 * The viewer pastes their own OpenRouter key; it is kept in this browser's localStorage and sent
 * only to openrouter.ai. The adapter exposes the same call shape as claude.ai's `sample`
 * capability, so every stage works unchanged. Only free models are offered. */
"use strict";
(function (PQ) {
  const API = "https://openrouter.ai/api/v1";
  const STORE_KEY = "pq:openrouter";
  // Free models that tend to follow long instructions and return clean JSON, best first.
  const PREFER = [/deepseek.*(v3|chat)/i, /qwen3|qwen-?2\.5-72b/i, /llama-4|llama-3\.3-70b/i, /gemini/i, /gpt-oss/i, /mistral|mixtral/i];
  const rank = (m) => {
    const i = PREFER.findIndex((re) => re.test(m.id));
    return i < 0 ? PREFER.length : i;
  };

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
      .filter((m) => /:free$/.test(m.id) || (m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0))
      .map((m) => {
        const arch = m.architecture || {};
        const inputs = PQ.arr(arch.input_modalities);
        return {
          id: m.id,
          name: m.name || m.id,
          context: Number(m.context_length) || 0,
          vision: inputs.includes("image") || /image/.test(arch.modality || ""),
        };
      })
      .filter((m) => m.context >= 16000)
      .sort((a, b) => rank(a) - rank(b) || b.context - a.context);
    return modelsCache;
  }

  /** Pick the main model, a vision model for page images, and fallbacks for busy free models. */
  function plan(models, chosenId) {
    const main = models.find((m) => m.id === chosenId) || models[0];
    const vision = main && main.vision ? main : models.find((m) => m.vision);
    const fallbacks = models.filter((m) => m !== main).slice(0, 2);
    return { main, vision, fallbacks };
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
        body: JSON.stringify({ model, stream: true, messages: [{ role: "user", content }] }),
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

  /** A `sample`-compatible function backed by OpenRouter. */
  function makeSample(cfg) {
    async function sample(input, opts = {}) {
      const text = typeof input === "string" ? input : input.map((t) => t.content).join("\n\n");
      const imgs = opts.images ? (Array.isArray(opts.images) ? opts.images : Array.from(opts.images.length != null ? opts.images : [opts.images])) : [];
      const useVision = imgs.length && cfg.visionModel;
      let content = text;
      if (useVision) content = [{ type: "text", text }, ...(await Promise.all(imgs.map(async (b) => ({ type: "image_url", image_url: { url: await blobToDataUrl(b) } }))))];
      const order = [useVision ? cfg.visionModel : cfg.model, ...PQ.arr(cfg.fallbacks)].filter((m, i, all) => m && all.indexOf(m) === i);
      let lastErr;
      for (const model of order) {
        // Fallback models may not read images; they get the text only.
        const body = model === (useVision ? cfg.visionModel : cfg.model) ? content : text;
        try {
          return await streamOnce(cfg, model, body, opts);
        } catch (e) {
          lastErr = e;
          const retryable = ["rate_limited", "upstream_error", "model_unavailable", "empty_completion"].includes(e.code) && !e.started;
          if (!retryable) throw e;
        }
      }
      throw lastErr;
    }
    sample.json = async (input, opts) => {
      const r = await sample(input, opts);
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
  async function connect(rawKey, chosenModelId) {
    const key = cleanKey(rawKey);
    if (!/^sk-or-/.test(key)) throw fail("bad_key", "An OpenRouter key starts with “sk-or-”. Copy the whole key from openrouter.ai/keys.");
    await checkKey(key);
    const models = await freeModels();
    if (!models.length) throw new Error("OpenRouter isn't offering any free models right now. Try again later.");
    const { main, vision, fallbacks } = plan(models, chosenModelId);
    const cfg = {
      key,
      model: main.id,
      modelName: main.name,
      visionModel: vision ? vision.id : null,
      fallbacks: fallbacks.map((m) => m.id),
      // Leave room for the reply: roughly 3 bytes of prompt text per token, capped at the app's usual size.
      maxBytes: Math.max(12000, Math.min(65536, Math.floor(main.context * 0.6 * 3))),
    };
    save(cfg);
    activate(cfg);
    return cfg;
  }

  PQ.openrouter = { load, save, freeModels, connect, activate, deactivate, cleanKey };
})(window.PQ);
