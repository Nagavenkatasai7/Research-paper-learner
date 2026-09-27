/* Paper Quest — Stage 6, Brainstorm Board: sticky notes that turn the paper into ideas of your own:
 * research directions, real-world uses, and links to papers you've already read. */
"use strict";
(function (PQ) {
  const { el, esc, str, arr, ask, pip, store } = PQ;

  const MODES = {
    research: {
      label: "Research ideas",
      kind: "Research idea",
      ask: "Research ideas: follow-up experiments, the obvious next paper, and small projects the learner could try to extend this work.",
    },
    use: {
      label: "Real-world uses",
      kind: "Real-world use",
      ask: "Real-world uses: where this idea could be applied in products, tools, or other fields, and who would benefit.",
    },
    connect: {
      label: "Connect to my papers",
      kind: "Connection",
      ask: "Connections: how this paper links to the learner's earlier papers listed below (shared ideas, contrasts, or ways to combine them). Name the earlier paper in each note.",
    },
  };
  const KIND_LABEL = { research: "Research idea", use: "Real-world use", connect: "Connection", mine: "My idea", combo: "Combined idea" };

  async function render(ctx, mount) {
    const bs = (await ctx.part("brainstorm")) || { notes: [] };
    bs.notes = arr(bs.notes);
    let alive = true;
    const selected = new Set();

    let others = [];
    try {
      others = (await store.list()).filter((p) => p.id !== ctx.paper.id && p.brain).sort((a, b) => (b.day || 0) - (a.day || 0)).slice(0, 12);
    } catch (e) {
      others = [];
    }

    mount.appendChild(
      PQ.quest.head(
        { eyebrow: "Stop 6 · Brainstorm", text: "Make it yours" },
        "Pip throws ideas on the board; you keep the good ones. Star at least one idea to finish today's quest. Select two notes to combine them."
      )
    );
    const tools = el(`<div class="bs-tools"></div>`);
    const mine = el(`<form class="mine-form card" hidden>
      <label class="label" for="mine-text">Your idea</label>
      <textarea id="mine-text" placeholder="What did this paper make you think of?"></textarea>
      <div class="controls"><button class="btn small primary" type="submit">Add to board</button><button class="btn small ghost" type="button" data-act="cancel">Cancel</button></div>
    </form>`);
    const boardEl = el(`<div class="board-notes"></div>`);
    mount.append(tools, mine, boardEl);

    const combineBtn = el(`<button class="btn" type="button" disabled>Combine selected</button>`);
    for (const [id, m] of Object.entries(MODES)) {
      const b = el(`<button class="btn ${id === "research" ? "primary" : ""}" type="button">${esc(m.label)}</button>`);
      if (id === "connect" && !others.length) {
        b.disabled = true;
        b.title = "Finish more papers to connect them";
      }
      b.addEventListener("click", () => generate(id, b));
      tools.appendChild(b);
    }
    const addMine = el(`<button class="btn ghost" type="button">Add my own idea</button>`);
    addMine.addEventListener("click", () => {
      mine.hidden = false;
      mine.querySelector("textarea").focus();
    });
    tools.append(addMine, combineBtn);
    mine.querySelector('[data-act="cancel"]').addEventListener("click", () => (mine.hidden = true));
    mine.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = mine.querySelector("textarea").value.trim();
      if (!text) return;
      mine.querySelector("textarea").value = "";
      mine.hidden = true;
      const words = text.split(/\s+/);
      bs.notes.unshift({ id: PQ.newId("n"), kind: "mine", title: words.slice(0, 7).join(" ") + (words.length > 7 ? "…" : ""), body: text, spark: "", more: "", starred: false });
      await ctx.savePart("brainstorm", bs);
      draw();
    });

    const earlier = () => others.map((p) => `Day ${p.day}: "${p.brain.title}" — ${p.brain.oneLiner}`).join("\n");

    async function generate(mode, btn) {
      btn.disabled = true;
      const holder = PQ.quest.centerNote(`Pip is brainstorming ${MODES[mode].label.toLowerCase()}…`);
      boardEl.prepend(holder);
      try {
        const raw = await pip.thinking(
          ask({
            task: "brainstorm",
            fresh: true,
            blocks: [
              `Brainstorm with the learner about this paper. Mode: ${MODES[mode].ask}`,
              `Reply with only JSON: {"notes": [{"title": string (at most 8 words), "body": string (2 or 3 sentences in simple words), "spark": string (one small first step the learner could try this week)}]} with exactly 4 notes. Be concrete and surprising, not generic.`,
              bs.notes.length ? `Don't repeat these ideas already on the board: ${bs.notes.map((n) => n.title).join("; ")}` : "",
              mode === "connect" ? { label: "THE LEARNER'S EARLIER PAPERS", text: earlier(), flex: true } : "",
              ctx.notes(),
            ].filter(Boolean),
          })
        );
        const notes = arr(raw && raw.notes)
          .map((n) => ({ id: PQ.newId("n"), kind: mode, title: str(n && n.title), body: str(n && n.body), spark: str(n && n.spark), more: "", starred: false }))
          .filter((n) => n.title && n.body);
        if (!notes.length) throw new PQ.AIError("invalid_json");
        bs.notes = [...notes, ...bs.notes].slice(0, 60);
        await ctx.savePart("brainstorm", bs);
        if (alive) draw();
      } catch (err) {
        if (alive) holder.replaceWith(PQ.errorBox(err, () => generate(mode, btn)));
      } finally {
        btn.disabled = mode === "connect" && !others.length;
      }
    }

    async function expand(note, btn) {
      btn.disabled = true;
      btn.textContent = "Pip is thinking…";
      try {
        const more = await pip.thinking(
          ask({
            task: "expand",
            json: false,
            fresh: true,
            blocks: [
              `Go deeper on this brainstorm idea about the paper, in 4 to 6 simple sentences: how it could work, what could go wrong, and what to read or try next. Plain text, no heading.\nIdea: ${note.title}\n${note.body}`,
              ctx.notes(),
            ],
          })
        );
        note.more = str(more);
        await ctx.savePart("brainstorm", bs);
        if (alive) draw();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "Go deeper";
        PQ.toast(err.message);
      }
    }

    combineBtn.addEventListener("click", async () => {
      const pair = bs.notes.filter((n) => selected.has(n.id));
      if (pair.length !== 2) return;
      combineBtn.disabled = true;
      const holder = PQ.quest.centerNote("Pip is mixing the two ideas…");
      boardEl.prepend(holder);
      try {
        const raw = await pip.thinking(
          ask({
            task: "combine",
            fresh: true,
            blocks: [
              `Combine these two brainstorm ideas about the paper into one new, stronger idea.\nA: ${pair[0].title}: ${pair[0].body}\nB: ${pair[1].title}: ${pair[1].body}`,
              `Reply with only JSON: {"title": string (at most 8 words), "body": string (2 or 3 simple sentences), "spark": string (one small first step)}`,
              ctx.notes(),
            ],
          })
        );
        const n = { id: PQ.newId("n"), kind: "combo", title: str(raw && raw.title), body: str(raw && raw.body), spark: str(raw && raw.spark), more: "", starred: false };
        if (!n.title) throw new PQ.AIError("invalid_json");
        bs.notes.unshift(n);
        selected.clear();
        await ctx.savePart("brainstorm", bs);
        if (alive) draw();
      } catch (err) {
        if (alive) holder.replaceWith(PQ.errorBox(err));
      }
    });

    function draw() {
      boardEl.innerHTML = "";
      combineBtn.disabled = selected.size !== 2;
      combineBtn.textContent = selected.size ? `Combine selected (${selected.size}/2)` : "Combine selected";
      if (!bs.notes.length) {
        boardEl.appendChild(PQ.quest.centerNote("The board is empty. Ask Pip for research ideas, real-world uses, or connections, or add your own.", "idle"));
        return;
      }
      bs.notes.forEach((n, i) => {
        const tilt = ((i * 37) % 5) - 2;
        const note = el(`<article class="note k-${esc(n.kind)} ${selected.has(n.id) ? "sel" : ""}" style="--tilt:${tilt * 0.6}deg">
          <span class="kind">${esc(KIND_LABEL[n.kind] || "Idea")}${n.starred ? " · ★ kept" : ""}</span>
          <h3>${esc(n.title)}</h3>
          ${n.body && n.body !== n.title ? `<p class="body">${esc(n.body)}</p>` : ""}
          ${n.spark ? `<p class="spark"><b>First step:</b> ${esc(n.spark)}</p>` : ""}
          ${n.more ? `<p class="more">${esc(n.more)}</p>` : ""}
          <div class="acts">
            <button type="button" data-act="star" aria-pressed="${!!n.starred}">${n.starred ? "★ Kept" : "☆ Keep"}</button>
            ${n.more ? "" : `<button type="button" data-act="more">Go deeper</button>`}
            <button type="button" data-act="sel" aria-pressed="${selected.has(n.id)}">${selected.has(n.id) ? "Selected" : "Select"}</button>
            <button type="button" data-act="del" aria-label="Remove note">Remove</button>
          </div>
        </article>`);
        note.querySelector('[data-act="star"]').addEventListener("click", async () => {
          n.starred = !n.starred;
          await ctx.savePart("brainstorm", bs);
          draw();
          if (n.starred && !ctx.paper.progress.brainstorm) ctx.complete("brainstorm");
        });
        const moreBtn = note.querySelector('[data-act="more"]');
        if (moreBtn) moreBtn.addEventListener("click", () => expand(n, moreBtn));
        note.querySelector('[data-act="sel"]').addEventListener("click", () => {
          if (selected.has(n.id)) selected.delete(n.id);
          else {
            if (selected.size >= 2) selected.delete(selected.values().next().value);
            selected.add(n.id);
          }
          draw();
        });
        note.querySelector('[data-act="del"]').addEventListener("click", async () => {
          bs.notes = bs.notes.filter((x) => x.id !== n.id);
          selected.delete(n.id);
          await ctx.savePart("brainstorm", bs);
          draw();
        });
        boardEl.appendChild(note);
      });
    }

    draw();
    return () => {
      alive = false;
    };
  }

  PQ.stages.brainstorm = { render };
})(window.PQ);
