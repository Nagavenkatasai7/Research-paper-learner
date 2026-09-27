/* Test double for the claude.ai artifact runtime (window.claude) used by dev/smoke.mjs.
 * It answers each Paper Quest prompt by its "TASK: <name>" line with canned data,
 * and keeps db/assets in memory. Never shipped with the app. */
(function () {
  const svg = (label) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360">
  <g class="step"><rect x="40" y="60" width="200" height="120" rx="18" fill="#d6efec" stroke="#1b2438" stroke-width="3"/><text x="70" y="130" font-family="Patrick Hand, cursive" font-size="26" fill="#1b2438">${label}</text></g>
  <g class="step"><path d="M250 120 L380 120" stroke="#138a80" stroke-width="4" stroke-linecap="round"/><path d="M365 105 L380 120 L365 135" stroke="#138a80" stroke-width="4" fill="none" stroke-linecap="round"/></g>
  <g class="step"><circle cx="480" cy="120" r="70" fill="#fff3c4" stroke="#1b2438" stroke-width="3"/><text x="440" y="128" font-family="Patrick Hand, cursive" font-size="24" fill="#1b2438">idea!</text></g>
  <g class="step" onclick="alert(1)"><script>alert(1)</script><text x="60" y="300" font-family="Patrick Hand, cursive" font-size="22" fill="#d2502f">words look at words</text></g>
</svg>`;

  const check = (q) => ({ q, options: ["The right answer", "A tempting wrong answer", "Another wrong answer"], answer: 0, why: "Because that's what the paper shows." });
  let teachTurns = 0;

  const answers = {
    notes: () => "Dense notes about this part of the paper (p.1).",
    brain: () => ({
      title: "Attention Is a Test Paper",
      authors: "Ada Lovelace, Alan Turing, Grace Hopper et al.",
      year: "2017",
      field: "NLP",
      oneLiner: "A model that lets every word look at every other word at once, so it reads faster and understands better.",
      keyIdeas: [
        { id: "k1", idea: "Older models read words one at a time, which is slow." },
        { id: "k2", idea: "Self-attention lets each word look at all the others at once." },
        { id: "k3", idea: "Scores between words become weights with a softmax." },
        { id: "k4", idea: "Several attention heads look for different patterns." },
        { id: "k5", idea: "The model beat older systems on translation while training faster." },
      ],
      keyEquations: [{ page: 2, what: "the attention formula" }],
      digest: "The paper replaces recurrence with attention (p.1). Method: queries, keys and values (p.2). Results: better BLEU, faster training (p.3). Limitations: cost grows with sequence length (p.3).",
    }),
    story_script: () => ({
      scenes: [
        ["The world before", "Reading one word at a time"],
        ["The problem", "Slow and forgetful"],
        ["The big idea", "Everyone looks at everyone"],
        ["How it works", "Scores become weights"],
        ["Did it work?", "Faster and better"],
        ["The catch", "Long texts get pricey"],
      ].map(([act, title]) => ({ act, title, narration: `${title}. Imagine a classroom where every kid can see every other kid at once.`, visual: "kids in a circle", check: check(`What is the key point of “${title}”?`) })),
    }),
    scene_svg: () => svg("Pip draws"),
    concept_svg: () => svg("analogy"),
    concept_map: () => ({
      concepts: [
        ["c1", "Neural network", "prereq"],
        ["c2", "Word embeddings", "prereq"],
        ["c3", "Self-attention", "core"],
        ["c4", "Multi-head attention", "core"],
        ["c5", "Positional encoding", "core"],
        ["c6", "Better translation", "result"],
      ].map(([id, name, kind]) => ({
        id,
        name,
        kind,
        levels: [`${name} for a 5-year-old.`, `${name} for a teen.`, `${name} for college.`, `${name} for a researcher.`],
        analogy: `${name} is like a classroom.`,
        where: "Section 3, p.2",
        check: check(`What does ${name} do?`),
      })),
      links: [
        { from: "c1", to: "c3", label: "builds" },
        { from: "c2", to: "c3", label: "feeds into" },
        { from: "c3", to: "c4", label: "repeated as" },
        { from: "c5", to: "c3", label: "adds order" },
        { from: "c4", to: "c6", label: "leads to" },
        { from: "c9", to: "c6", label: "dangling" },
      ],
    }),
    section_guide: () => ({
      job: "This section explains the recipe.",
      lookFor: ["Figure 1, the model diagram", "Equation 1"],
      skip: ["The exact hyperparameters"],
      jargon: [{ term: "softmax", meaning: "turns scores into percentages that add up to 100" }],
      question: "Why look at all words at once?",
    }),
    explain_page: () => "**This page** shows the model.\n\n- Figure 1: boxes are layers.\n- Notice the arrows.",
    ask: () => "Because dividing keeps the numbers small. It's like turning down the volume.",
    xray: () => ({
      equations: [
        {
          name: "Scaled dot-product attention",
          latex: "\\mathrm{Attention}(Q,K,V)=\\mathrm{softmax}\\left(\\frac{QK^T}{\\sqrt{d_k}}\\right)V",
          parts: [
            { tex: "\\mathrm{Attention}(Q,K,V)", meaning: "what we want to compute" },
            { tex: "=", meaning: "is made like this" },
            { tex: "\\mathrm{softmax}", meaning: "turn scores into percentages" },
            { tex: "\\left(\\frac{QK^T}{\\sqrt{d_k}}\\right)", meaning: "how well words match, kept calm" },
            { tex: "V", meaning: "the information we grab" },
          ],
          recipe: "Score every pair of words, turn scores into percentages, then mix the information.",
          example: "Scores 2 and 0 become about 88% and 12%.",
        },
        { name: "Broken split", latex: "a+b=c", parts: [{ tex: "\\frac{a", meaning: "bad part" }, { tex: "}{b}", meaning: "bad part" }], recipe: "Falls back to the whole equation.", example: "" },
      ],
    }),
    teach: () => {
      teachTurns++;
      const covered = ["k1", "k2", "k3", "k4", "k5"].slice(0, Math.min(5, teachTurns * 2));
      return { reply: "Ooh! But why does looking at everyone help?", covered, partial: teachTurns === 1 ? ["k3"] : [], mixup: teachTurns === 1 ? "Small fix: it's not a memory bank." : "", mood: "curious" };
    },
    hint: () => "Look at Section 3 and think about what the heads each notice.",
    brainstorm: () => ({
      notes: [1, 2, 3, 4].map((i) => ({ title: `Idea number ${i}`, body: "Try attention on music notes.", spark: "Find a small MIDI dataset." })),
    }),
    expand: () => "It could work by treating notes like words. It could fail on long songs.",
    combine: () => ({ title: "Music plus translation", body: "Translate melodies between styles.", spark: "Try two short songs." }),
  };

  const calls = [];
  window.__mockCalls = calls;

  async function sample(input, opts = {}) {
    const text = typeof input === "string" ? input : input.map((t) => t.content).join("\n");
    const task = (text.match(/^TASK: (\w+)/) || [])[1] || "unknown";
    calls.push({ task, bytes: new TextEncoder().encode(text).length, images: !!opts.images, tier: opts.modelTier });
    if (new TextEncoder().encode(text).length > 65536) throw { code: "prompt_too_large", message: "too big" };
    await new Promise((r) => setTimeout(r, 60));
    const fn = answers[task];
    if (!fn) throw { code: "upstream_error", message: `no mock for ${task}` };
    const out = fn();
    const s = typeof out === "string" ? out : JSON.stringify(out);
    if (opts.onText) opts.onText({ text: s, delta: s });
    return { text: s, truncated: false, modelTierApplied: opts.modelTier || "default" };
  }
  sample.json = async (input, opts) => JSON.parse((await sample(input, opts)).text);
  sample.limits = async () => ({ maxPromptBytes: 65536, images: { maxCount: 4, maxInputBytes: 20e6, mediaTypes: ["image/jpeg", "image/png"] } });

  /* In-memory document store with the same path grammar. */
  const docs = new Map();
  const snap = (id, v) => ({ id, exists: v !== undefined, data: () => (v === undefined ? undefined : JSON.parse(JSON.stringify(v))), metadata: { fromCache: false, hasPendingWrites: false } });
  function docRef(path) {
    const segs = path.split("/");
    if (segs.length % 2) throw new TypeError(`doc path needs an even number of segments: ${path}`);
    return {
      id: segs[segs.length - 1],
      path,
      get: async () => snap(segs[segs.length - 1], docs.get(path)),
      set: async (d) => {
        if (JSON.stringify(d).length > 256 * 1024) throw { code: "invalid_argument", message: "doc too big" };
        docs.set(path, JSON.parse(JSON.stringify(d)));
      },
      update: async (d) => docs.set(path, { ...(docs.get(path) || {}), ...d }),
      delete: async () => docs.delete(path),
      collection: (c) => colRef(`${path}/${c}`),
    };
  }
  function colRef(path) {
    if (path.split("/").length % 2 === 0) throw new TypeError(`collection path needs an odd number of segments: ${path}`);
    return {
      path,
      doc: (id) => docRef(`${path}/${id}`),
      get: async () => {
        const out = [];
        for (const [k, v] of docs) {
          const rest = k.slice(path.length + 1);
          if (k.startsWith(path + "/") && !rest.includes("/")) out.push(snap(rest, v));
        }
        return { docs: out, size: out.length, empty: !out.length };
      },
    };
  }
  const db = { doc: docRef, collection: colRef };
  window.__mockDocs = docs;

  const blobs = new Map();
  const assets = {
    upload: async (blob) => {
      const id = Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32);
      blobs.set(id, blob);
      return { id, url: `/_blob/${id}`, sizeBytes: blob.size, contentType: blob.type };
    },
    delete: async (id) => ({ deleted: blobs.delete(id) }),
    list: async () => ({ assets: [], usage: {} }),
  };
  const realFetch = window.fetch.bind(window);
  window.fetch = (url, init) => {
    const m = String(url).match(/\/_blob\/(\w+)/);
    if (m) return Promise.resolve(blobs.has(m[1]) ? new Response(blobs.get(m[1])) : new Response("", { status: 404 }));
    return realFetch(url, init);
  };

  const user = { id: async () => "u_test", isOwner: async () => true, canEdit: async () => true };
  const caps = { sample, db, assets, user };
  window.claude = { use: (name) => new Promise((r) => setTimeout(() => r(caps[name] || null), 20)) };
})();
