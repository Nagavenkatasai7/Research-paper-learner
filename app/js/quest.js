/* Paper Quest — the quest shell for one paper: the six-stop track, stage locks,
 * and the shared context every stage receives. */
"use strict";
(function (PQ) {
  const { el, esc, svc, store, pip } = PQ;

  PQ.stages = PQ.stages || {};
  /** Parsed PDFs for this visit: paperId -> {doc, x} */
  PQ.cache = PQ.cache || new Map();

  let cleanup = null;
  function runCleanup() {
    if (typeof cleanup === "function") {
      try {
        cleanup();
      } catch (e) {
        console.warn(e);
      }
    }
    cleanup = null;
    pip.speech.stop();
  }
  PQ.leaveStage = runCleanup;

  function stageIndex(id) {
    return PQ.STAGES.findIndex((s) => s.id === id);
  }
  function isUnlocked(paper, id) {
    const i = stageIndex(id);
    if (i <= 0) return true;
    if (paper.unlocked && paper.unlocked[id]) return true;
    return !!(paper.progress && paper.progress[PQ.STAGES[i - 1].id]);
  }
  function firstOpenStage(paper) {
    const s = PQ.STAGES.find((st) => !(paper.progress && paper.progress[st.id]));
    return s ? s.id : PQ.STAGES[PQ.STAGES.length - 1].id;
  }

  function qbar(paper, current, onPick) {
    const bar = el(`<header class="qbar"><div class="wrap">
      <button class="btn small ghost" type="button" data-act="home" aria-label="Back to library">← Library</button>
      <div class="qtitle"><span class="day-tag">Day ${paper.day}</span><h2 title="${esc(paper.title)}">${esc(paper.title)}</h2></div>
      <ol class="stops" aria-label="Quest stops"></ol>
    </div></header>`);
    const ol = bar.querySelector(".stops");
    PQ.STAGES.forEach((s, i) => {
      const done = !!(paper.progress && paper.progress[s.id]);
      const locked = !isUnlocked(paper, s.id);
      const li = el(`<li class="${done ? "done" : ""}"><button type="button" class="stop ${done ? "done" : ""} ${s.id === current ? "current" : ""} ${locked ? "locked" : ""}"
        aria-current="${s.id === current ? "step" : "false"}" title="${locked ? `Finish ${esc(PQ.STAGES[i - 1].label)} to unlock` : esc(s.blurb)}">
        <span class="dot">${done ? "✓" : i + 1}</span><span class="lbl">${esc(s.label)}</span></button></li>`);
      li.querySelector("button").addEventListener("click", () => onPick(s.id));
      ol.appendChild(li);
    });
    bar.querySelector('[data-act="home"]').addEventListener("click", () => PQ.go({ name: "library" }));
    return bar;
  }

  function centerNote(text, mood = "think") {
    return el(`<div class="center-note"><div class="bot">${pip.svg(mood)}</div><p>${esc(text)}</p></div>`);
  }

  /** Load and parse the paper's PDF, asking for a re-upload if this device lost it. */
  async function loadDoc(paper, area) {
    if (PQ.cache.has(paper.id)) return PQ.cache.get(paper.id);
    PQ.clear(area).appendChild(centerNote("Opening your paper…"));
    const blob = await store.loadPdf(paper);
    if (!blob) {
      return new Promise((resolve) => {
        const box = el(`<div class="gate card">
          <div class="bot">${pip.svg("confused")}</div>
          <h2>Pip can't find this PDF</h2>
          <p class="muted">It isn't saved on this device. Choose the same PDF again and your progress stays as it is.</p>
          <label class="btn primary" for="reupload">Choose the PDF<input id="reupload" type="file" accept="application/pdf,.pdf" hidden></label>
        </div>`);
        box.querySelector("input").addEventListener("change", async (e) => {
          const f = e.target.files && e.target.files[0];
          if (!f) return;
          const asset = await store.savePdf(paper.id, f);
          if (asset) {
            paper.pdfAsset = asset;
            await store.put(paper);
          }
          resolve(loadDoc(paper, area));
        });
        PQ.clear(area).appendChild(box);
      });
    }
    const doc = await PQ.pdf.open(blob);
    const x = await PQ.pdf.extract(doc, (n, t) => {
      const p = area.querySelector(".center-note p");
      if (p) p.textContent = `Reading page ${n} of ${t}…`;
    });
    const entry = { doc, x };
    PQ.cache.set(paper.id, entry);
    return entry;
  }

  async function open(mount, id, wanted) {
    runCleanup();
    pip.showDock(true);
    const paper = await store.get(id);
    if (!paper) {
      PQ.toast("That paper isn't in your library anymore.");
      return PQ.go({ name: "library" });
    }
    paper.progress = paper.progress || {};
    const stageId = wanted || paper.stage || firstOpenStage(paper);

    const shell = el(`<div class="quest"></div>`);
    const area = el(`<main class="stage"><div class="wrap stage-inner"></div></main>`);
    const pick = (sid) => PQ.go({ name: "paper", id: paper.id, stage: sid });
    shell.appendChild(qbar(paper, stageId, pick));
    shell.appendChild(area);
    PQ.clear(mount).appendChild(shell);
    const inner = area.firstElementChild;

    let entry;
    try {
      entry = await loadDoc(paper, inner);
    } catch (err) {
      console.error(err);
      PQ.clear(inner).appendChild(PQ.errorBox(err, () => open(mount, id, wanted)));
      return;
    }

    if (!paper.brain) {
      const gate = el(`<div class="gate card">
        <div class="bot">${pip.svg(svc.sample ? "idle" : "confused")}</div>
        <h2>Pip hasn't read this paper yet</h2>
        <p class="muted">${svc.sample ? "Pip needs a minute or two to read it and write study notes. Every stage of the quest is built from them." : "Pip can only think when this page is open in Claude. Open it from claude.ai while signed in, then come back to this paper."}</p>
      </div>`);
      if (svc.sample) {
        const b = el(`<button class="btn primary" type="button">Let Pip read it</button>`);
        b.addEventListener("click", () => PQ.makeBrain(paper, entry.x));
        gate.appendChild(b);
      }
      PQ.clear(inner).appendChild(gate);
      return;
    }

    if (!isUnlocked(paper, stageId)) {
      const i = stageIndex(stageId);
      const prev = PQ.STAGES[i - 1];
      const target = PQ.STAGES[i];
      const gate = el(`<div class="gate card">
        <div class="bot">${pip.svg()}</div>
        <h2>${esc(target.label)} is still locked</h2>
        <p class="muted">Finish <b>${esc(prev.label)}</b> first. Each stop builds on the one before, so the ideas stick.</p>
        <button class="btn primary" type="button" data-go>Go to ${esc(prev.label)}</button>
        <button class="linkish" type="button" data-skip>Skip ahead anyway</button>
      </div>`);
      gate.querySelector("[data-go]").addEventListener("click", () => pick(prev.id));
      gate.querySelector("[data-skip]").addEventListener("click", async () => {
        paper.unlocked = { ...(paper.unlocked || {}), [stageId]: true };
        await store.put(paper);
        pick(stageId);
      });
      PQ.clear(inner).appendChild(gate);
      return;
    }

    if (paper.stage !== stageId) {
      paper.stage = stageId;
      store.put(paper);
    }
    try {
      localStorage.setItem("pq:last", JSON.stringify({ id: paper.id, stage: stageId }));
    } catch (e) {
      /* ignore */
    }

    const parts = {};
    const ctx = {
      paper,
      brain: paper.brain,
      doc: entry.doc,
      x: entry.x,
      stageId,
      /** Paper notes as a prompt block, trimmed to fit. */
      notes(label = "PAPER NOTES (your own study notes, with page tags)") {
        return { label, text: `Title: ${paper.brain.title}\nOne-liner: ${paper.brain.oneLiner}\n\n${paper.brain.digest}`, flex: true };
      },
      async part(name) {
        if (!(name in parts)) {
          try {
            parts[name] = (await store.getPart(paper.id, name)) || null;
          } catch (e) {
            console.warn(e);
            parts[name] = null;
          }
        }
        return parts[name];
      },
      async savePart(name, data) {
        parts[name] = data;
        try {
          await store.putPart(paper.id, name, data);
        } catch (e) {
          console.error(e);
          PQ.toast(e && e.code === "quota_exceeded" ? "Storage is full. Delete an old paper to keep saving." : "Couldn't save just now. Your work stays on screen; try again in a moment.");
        }
      },
      async complete(id) {
        if (paper.progress[id]) return;
        paper.progress[id] = true;
        await store.put(paper);
        const i = stageIndex(id);
        const bar = shell.querySelector(".qbar");
        bar.replaceWith(qbar(paper, stageId, pick));
        if (PQ.STAGES.every((s) => paper.progress[s.id])) {
          pip.cheer(`Day ${paper.day} quest complete! You really know this paper now.`);
          PQ.toast(`Day ${paper.day} complete. See you tomorrow for the next paper!`, { label: "Library", run: () => PQ.go({ name: "library" }) });
        } else if (i + 1 < PQ.STAGES.length) {
          const next = PQ.STAGES[i + 1];
          pip.cheer(`${PQ.STAGES[i].label} cleared!`);
          PQ.toast(`${PQ.STAGES[i].label} cleared. ${next.label} is unlocked.`, { label: `Go to ${next.label}`, run: () => pick(next.id) });
        }
      },
      go: pick,
    };

    const stage = PQ.stages[stageId];
    PQ.clear(inner);
    try {
      cleanup = await stage.render(ctx, inner);
    } catch (err) {
      console.error(err);
      inner.appendChild(PQ.errorBox(err, () => open(mount, id, stageId)));
    }
  }

  /** Shared heading block for stages. */
  function head(title, lede, extra) {
    const h = el(`<div class="stage-head"><div><p class="eyebrow">${esc(title.eyebrow)}</p><h1>${esc(title.text)}</h1><p>${esc(lede)}</p></div></div>`);
    if (extra) h.appendChild(extra);
    return h;
  }

  /** Multiple-choice check used by Story and Map. Calls onAnswer(correct, chosenIndex). */
  function checkQuestion(check, prevChoice, onAnswer) {
    const box = el(`<div class="check card"><p class="label">Quick check</p><p class="q">${esc(check.q)}</p><div class="opts"></div><div class="why" hidden></div></div>`);
    const opts = box.querySelector(".opts");
    const why = box.querySelector(".why");
    const buttons = check.options.map((o, i) => {
      const b = el(`<button class="opt" type="button">${esc(o)}</button>`);
      b.addEventListener("click", () => choose(i, true));
      opts.appendChild(b);
      return b;
    });
    function choose(i, fresh) {
      const right = i === check.answer;
      buttons.forEach((b, j) => {
        b.classList.remove("right", "wrong");
        if (j === i) b.classList.add(right ? "right" : "wrong");
        if (right) b.disabled = true;
      });
      why.hidden = false;
      why.textContent = right ? `Yes! ${check.why || ""}` : "Not quite. Have another look and try again.";
      if (fresh) onAnswer(right, i);
    }
    if (prevChoice != null && prevChoice === check.answer) choose(prevChoice, false);
    return box;
  }

  /** Normalize a model-written multiple-choice check. */
  function cleanCheck(c) {
    const options = PQ.arr(c && c.options).map((o) => PQ.str(o)).filter(Boolean).slice(0, 4);
    let answer = Number(c && c.answer);
    if (!Number.isInteger(answer) || answer < 0 || answer >= options.length) answer = 0;
    return { q: PQ.str(c && c.q) || "Which of these is true?", options: options.length >= 2 ? options : ["Yes", "No"], answer, why: PQ.str(c && c.why) };
  }

  PQ.quest = { open, isUnlocked, firstOpenStage, head, centerNote, checkQuestion, cleanCheck };
})(window.PQ);
