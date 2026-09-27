/* Paper Quest — the library (Day N cards, drop zone) and the intake pipeline:
 * PDF → text → Pip's private study notes ("brain") that every stage builds on. */
"use strict";
(function (PQ) {
  const { el, esc, str, arr, svc, store, ask, pip } = PQ;

  const STAGES = [
    { id: "story", label: "Story", blurb: "Watch the paper as a narrated cartoon." },
    { id: "map", label: "Map", blurb: "Light up every idea on a foggy concept map." },
    { id: "read", label: "Read", blurb: "Read the real PDF with Pip beside you." },
    { id: "xray", label: "X-ray", blurb: "See every piece of the key equations." },
    { id: "teach", label: "Teach", blurb: "Explain it to five-year-old Pip." },
    { id: "brainstorm", label: "Brainstorm", blurb: "Spin the paper into ideas of your own." },
  ];
  PQ.STAGES = STAGES;

  const doneCount = (p) => STAGES.filter((s) => p.progress && p.progress[s.id]).length;

  /* ---------------- Pip's study notes ---------------- */
  const MAIN_BUDGET = 46000; // bytes of paper text sent in one go

  function brainBlocks(sourceLabel, text) {
    return [
      "Read this research paper and write the study notes you (Pip) will teach from later. The learner never sees these notes directly, so be accurate and complete rather than cute.",
      `Reply with only JSON of this shape:
{"title": string, "authors": string (first three authors, then "et al." if more), "year": string or "",
 "field": string (for example "NLP" or "computer vision"),
 "oneLiner": string (the whole paper in one sentence a 10-year-old would get, at most 30 words),
 "keyIdeas": [{"id": "k1", "idea": string}] (5 to 7 ideas someone must be able to explain to prove they understood the paper; one sentence each),
 "keyEquations": [{"page": number, "what": string}] (0 to 5 of the most important equations; "page" comes from the [[p.N]] markers; "what" is at most 10 plain words),
 "digest": string (dense plain-text notes of 900 to 1600 words: the problem and why it matters, what came before, the core idea, the method step by step, the experiments with datasets and headline numbers, and the limitations. Tag each claim with its page like (p.4).)}`,
      { label: sourceLabel, text, flex: true },
    ];
  }

  function cleanBrain(b, fallbackTitle) {
    b = b && typeof b === "object" ? b : {};
    const keyIdeas = arr(b.keyIdeas)
      .map((k, i) => ({ id: str(k && k.id) || `k${i + 1}`, idea: str(k && k.idea) }))
      .filter((k) => k.idea)
      .slice(0, 8);
    return {
      title: str(b.title) || fallbackTitle,
      authors: str(b.authors),
      year: str(b.year),
      field: str(b.field),
      oneLiner: str(b.oneLiner),
      keyIdeas,
      keyEquations: arr(b.keyEquations)
        .map((e) => ({ page: Number(e && e.page) || 0, what: str(e && e.what) }))
        .filter((e) => e.page > 0)
        .slice(0, 6),
      digest: str(b.digest),
    };
  }

  /** Build the study notes; long papers are condensed chunk by chunk first. */
  async function buildBrain(paper, x, status) {
    let source = x.mainText;
    let label = "PAPER TEXT (pages marked [[p.N]])";
    if (PQ.byteLen(source) > MAIN_BUDGET) {
      const chunks = [];
      let cur = "";
      for (const part of source.split(/(?=\n\[\[p\.\d+\]\]\n)/)) {
        if (cur && PQ.byteLen(cur + part) > 38000) {
          chunks.push(cur);
          cur = "";
        }
        cur += part;
      }
      if (cur) chunks.push(cur);
      const notes = [];
      for (let i = 0; i < chunks.length; i++) {
        status(`This paper is long, so Pip is taking notes on part ${i + 1} of ${chunks.length}…`, (i / (chunks.length + 1)) * 100);
        const text = await ask({
          task: "notes",
          json: false,
          blocks: [
            `This is part ${i + 1} of ${chunks.length} of a research paper. Write dense study notes on this part only (at most 900 words). Keep every number, dataset, equation (in words or LaTeX), and design choice. Tag claims with their page like (p.4). Plain text, no preamble.`,
            { label: "PAPER PART", text: chunks[i], flex: true },
          ],
        });
        notes.push(text);
      }
      source = notes.join("\n\n");
      label = "PAPER NOTES (condensed from the full paper, with page tags)";
    }
    status("Pip is thinking about the big picture…", 80);
    let chars = 0;
    const raw = await ask({
      task: "brain",
      tier: "complex",
      blocks: brainBlocks(label, source),
      onText: ({ text }) => {
        if (text.length - chars > 400) {
          chars = text.length;
          status(`Pip is writing its study notes… ${Math.round(text.length / 6)} words so far`, Math.min(98, 80 + text.length / 250));
        }
      },
    });
    const brain = cleanBrain(raw, paper.title);
    if (!brain.digest || !brain.keyIdeas.length) throw new PQ.AIError("invalid_json");
    return brain;
  }

  /* ---------------- Intake ---------------- */
  function overlay() {
    const o = el(`<div class="overlay"><div class="panel card">
      <div class="bot">${pip.svg("think")}</div>
      <h2>Pip is reading your paper</h2>
      <p class="status muted">Opening the PDF…</p>
      <div class="meter" aria-hidden="true"><i></i></div>
      <div class="actions"></div>
    </div></div>`);
    document.body.appendChild(o);
    return {
      node: o,
      status(text, pct) {
        o.querySelector(".status").textContent = text;
        if (pct != null) o.querySelector(".meter > i").style.width = `${Math.max(3, Math.min(100, pct))}%`;
      },
      fail(err, retry, cancel) {
        pip.setMood(o, "confused");
        o.querySelector("h2").textContent = "Pip got stuck";
        o.querySelector(".status").textContent = err.message || String(err);
        const acts = o.querySelector(".actions");
        acts.innerHTML = "";
        if (retry) {
          const b = el(`<button class="btn primary" type="button">Try again</button>`);
          b.addEventListener("click", retry);
          acts.appendChild(b);
        }
        const c = el(`<button class="btn ghost" type="button">${cancel ? "Close" : "OK"}</button>`);
        c.addEventListener("click", () => {
          o.remove();
          if (cancel) cancel();
        });
        acts.appendChild(c);
      },
      close() {
        o.remove();
      },
    };
  }

  async function ingest(file) {
    if (!file) return;
    if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) {
      PQ.toast("That isn't a PDF. Pick a .pdf file.");
      return;
    }
    if (file.size > 60 * 1024 * 1024) {
      PQ.toast("That PDF is over 60 MB. Try a smaller file.");
      return;
    }
    const ui = overlay();
    try {
      const doc = await PQ.pdf.open(file);
      const x = await PQ.pdf.extract(doc, (n, total) => ui.status(`Reading page ${n} of ${total}…`, (n / total) * 30));
      if (x.mainText.replace(/\[\[p\.\d+\]\]|\s/g, "").length < 500) {
        throw new Error("Pip couldn't find readable text in this PDF. It may be a scan; try a PDF with selectable text.");
      }
      const papers = await store.list();
      const day = papers.reduce((m, p) => Math.max(m, p.day || 0), 0) + 1;
      const title = (await PQ.pdf.metaTitle(doc)) || file.name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ");
      const paper = {
        id: PQ.newId("p"),
        day,
        title,
        fileName: file.name,
        createdAt: new Date().toISOString(),
        numPages: x.numPages,
        pdfAsset: null,
        brain: null,
        progress: {},
        stage: "story",
      };
      ui.status("Saving your PDF…", 34);
      paper.pdfAsset = await store.savePdf(paper.id, file);
      await store.put(paper);
      PQ.cache.set(paper.id, { doc, x });
      await makeBrain(paper, x, ui);
    } catch (err) {
      console.error(err);
      ui.fail(err, null, null);
    }
  }

  /** Run (or re-run) the study-notes step for a saved paper, then open it. */
  async function makeBrain(paper, x, ui) {
    ui = ui || overlay();
    if (!svc.sample) {
      ui.close();
      PQ.toast("Saved. Pip will build this quest when the page is open in Claude.");
      PQ.go({ name: "paper", id: paper.id });
      return;
    }
    try {
      ui.status("Pip is skimming the whole paper…", 40);
      const brain = await buildBrain(paper, x, (t, pct) => ui.status(t, pct));
      paper.brain = brain;
      paper.title = brain.title || paper.title;
      await store.put(paper);
      ui.close();
      pip.cheer("Got it! Let's start with the story.");
      PQ.go({ name: "paper", id: paper.id });
    } catch (err) {
      console.error(err);
      ui.fail(
        err,
        () => {
          ui.close();
          makeBrain(paper, x);
        },
        () => PQ.go({ name: "paper", id: paper.id })
      );
    }
  }
  PQ.makeBrain = makeBrain;

  /* ---------------- Pip's brain (outside claude.ai) ---------------- */
  function brainCard() {
    const cfg = PQ.openrouter.load();
    const connected = !!(svc.provider && cfg && cfg.key);
    const card = el(`<section class="brain card" aria-labelledby="brain-h">
      <div><p class="eyebrow">Pip's brain</p><h2 id="brain-h">${connected ? "Thinking with a free OpenRouter model" : "Give Pip a free brain"}</h2></div>
      <p class="muted">${
        connected
          ? `Pip is using <b>${esc(cfg.modelName || cfg.model)}</b>${cfg.visionModel ? "" : " (it can't see page images, so figures are explained from the page text)"}. Free models are slower than Claude and allow only a few requests a minute.`
          : "Outside claude.ai, Pip can think with OpenRouter's free models. Paste your OpenRouter key: it stays in this browser and is only ever sent to openrouter.ai."
      }</p>
      <form class="brain-form">
        ${connected ? "" : `<label class="label" for="or-key">OpenRouter key</label><input id="or-key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-or-v1-…" required>`}
        <label class="label" for="or-model">Free model</label>
        <select id="or-model"><option value="">Best available (recommended)</option></select>
        <div class="controls">
          <button class="btn primary" type="submit">${connected ? "Switch model" : "Connect"}</button>
          ${connected ? `<button class="btn ghost" type="button" data-act="forget">Disconnect and forget key</button>` : `<a class="linkish" href="https://openrouter.ai/keys" target="_blank" rel="noopener">Get a key</a>`}
        </div>
        <p class="status muted" role="status"></p>
      </form>
    </section>`);
    const form = card.querySelector("form");
    const select = card.querySelector("#or-model");
    const status = card.querySelector(".status");
    PQ.openrouter
      .freeModels()
      .then((models) => {
        for (const m of models) {
          const o = el(`<option value="${esc(m.id)}">${esc(m.name)}${m.vision ? " · sees images" : ""}</option>`);
          if (connected && cfg.model === m.id) o.selected = true;
          select.appendChild(o);
        }
      })
      .catch((err) => (status.textContent = err.message));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const key = connected ? cfg.key : card.querySelector("#or-key").value;
      if (!key.trim()) return;
      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      status.textContent = "Checking with OpenRouter…";
      try {
        const saved = await pip.thinking(PQ.openrouter.connect(key, select.value));
        PQ.refreshBanner();
        pip.cheer(`My brain is online: ${saved.modelName}!`);
        PQ.go({ name: "library" });
      } catch (err) {
        status.textContent = err && err.code ? new PQ.AIError(err.code, null, err.detail).message : (err && err.message) || String(err);
        btn.disabled = false;
      }
    });
    const forget = card.querySelector('[data-act="forget"]');
    if (forget)
      forget.addEventListener("click", () => {
        PQ.openrouter.deactivate();
        PQ.refreshBanner();
        PQ.go({ name: "library" });
      });
    return card;
  }

  /* ---------------- Library view ---------------- */
  function hundredGrid(papers) {
    const byDay = new Map(papers.map((p) => [p.day, p]));
    let cells = "";
    for (let d = 1; d <= 100; d++) {
      const p = byDay.get(d);
      const cls = p ? (doneCount(p) === STAGES.length ? "on" : "part") : "";
      cells += `<i class="${cls}" title="Day ${d}${p ? `: ${esc(p.title)}` : ""}"></i>`;
    }
    return `<div class="hundred" aria-hidden="true">${cells}</div>`;
  }

  function paperCard(p) {
    const n = doneCount(p);
    const b = el(`<button class="paper-card card" type="button">
      <span class="day-tag">Day ${p.day}</span>
      <h3>${esc(p.title)}</h3>
      <p class="one">${esc((p.brain && p.brain.oneLiner) || "Pip hasn't built this quest yet. Open it to finish.")}</p>
      <div class="foot">
        <div class="mini-track" aria-label="${n} of ${STAGES.length} stops done">${STAGES.map((s) => `<i class="${p.progress && p.progress[s.id] ? "on" : ""}"></i>`).join("")}</div>
        <span class="label">${n === STAGES.length ? "Quest done" : `${n}/${STAGES.length}`}</span>
      </div>
    </button>`);
    b.addEventListener("click", () => PQ.go({ name: "paper", id: p.id }));
    return b;
  }

  async function render(mount) {
    pip.showDock(true);
    let papers = [];
    try {
      papers = await store.list();
    } catch (e) {
      console.error(e);
    }
    papers.sort((a, b) => (b.day || 0) - (a.day || 0));
    const finished = papers.filter((p) => doneCount(p) === STAGES.length).length;
    const nextDay = papers.reduce((m, p) => Math.max(m, p.day || 0), 0) + 1;

    const view = el(`<div class="wrap lib">
      <header class="hero">
        <div class="bot">${pip.svg()}</div>
        <div>
          <p class="eyebrow">100 papers · 100 days</p>
          <h1>Paper <span class="mark">Quest</span></h1>
          <p class="lede">Drop in a research paper. Pip turns it into a one-day quest: a cartoon story, a concept map to light up, a guided read, equation X-rays, a teach-back, and a brainstorm.</p>
          <div class="stats">
            <span><b>${papers.length}</b>papers started</span>
            <span><b>${finished}</b>quests finished</span>
            <span><b>${Math.max(0, 100 - papers.length)}</b>days to go</span>
          </div>
          ${hundredGrid(papers)}
        </div>
      </header>
      <section class="lib-grid" aria-label="Your papers"></section>
      <section class="route card" aria-label="How a quest works">
        <h2>How a day's quest works</h2>
        <ol>${STAGES.map((s) => `<li><b>${esc(s.label)}</b><span class="muted">${esc(s.blurb)}</span></li>`).join("")}</ol>
      </section>
    </div>`);

    const grid = view.querySelector(".lib-grid");
    // Outside claude.ai, connecting a brain is step one, so the card leads until it's done.
    if (!svc.inViewer) (svc.sample ? grid.after.bind(grid) : grid.before.bind(grid))(brainCard());
    const drop = el(`<label class="drop" for="pdf-input">
      <span class="day-tag">Day ${nextDay}</span>
      <h3>Start a new quest</h3>
      <span class="muted">Drop a paper's PDF here, or click to choose one.</span>
      <input type="file" id="pdf-input" accept="application/pdf,.pdf">
    </label>`);
    const input = drop.querySelector("input");
    input.addEventListener("change", () => {
      const f = input.files && input.files[0];
      input.value = "";
      ingest(f);
    });
    drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.classList.add("over");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("over");
      ingest(e.dataTransfer.files && e.dataTransfer.files[0]);
    });
    grid.appendChild(drop);
    papers.forEach((p) => grid.appendChild(paperCard(p)));

    PQ.clear(mount).appendChild(view);
    if (!svc.sample) pip.say("Hi, I'm Pip! Give me a brain first, then drop in your first paper.", { ms: 9000 });
    else if (!papers.length) pip.say("Hi, I'm Pip! Drop in your first paper and I'll turn it into a quest.", { ms: 9000 });
  }

  PQ.library = { render, ingest, doneCount };
})(window.PQ);
