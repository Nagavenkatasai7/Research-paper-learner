/* Paper Quest — Stage 3, Guided Reading: the real PDF beside Pip. Each section gets a reading
 * map (what it does, what to look for, what to skip); any page can be explained; questions stay short
 * and focused so the chat never runs out of room. */
"use strict";
(function (PQ) {
  const { el, esc, str, arr, ask, pip } = PQ;

  async function makeGuide(ctx, sec) {
    const raw = await ask({
      task: "section_guide",
      blocks: [
        `The learner is about to read the section "${sec.title}" (starts on page ${sec.page}). Give them a reading map for it.`,
        `Reply with only JSON:
{"job": string (what this section does for the paper, 1 or 2 sentences a 5-year-old would get),
 "lookFor": [2 to 4 strings: specific things to notice while reading; name figures, tables or equations when the section has them],
 "skip": [0 to 3 strings: parts a beginner can skim on a first read],
 "jargon": [{"term": string, "meaning": string (kid-friendly, at most 15 words)}] (0 to 6 terms used in this section),
 "question": string (one question to keep in mind while reading)}`,
        ctx.notes(),
        { label: `SECTION TEXT: ${sec.title}`, text: ctx.x.sectionText(sec), flex: true },
      ],
    });
    return {
      job: str(raw && raw.job),
      lookFor: arr(raw && raw.lookFor).map((s) => str(s)).filter(Boolean).slice(0, 5),
      skip: arr(raw && raw.skip).map((s) => str(s)).filter(Boolean).slice(0, 4),
      jargon: arr(raw && raw.jargon)
        .map((j) => ({ term: str(j && j.term), meaning: str(j && j.meaning) }))
        .filter((j) => j.term && j.meaning)
        .slice(0, 8),
      question: str(raw && raw.question),
    };
  }

  async function explainPage(ctx, n, onText) {
    let images;
    if (PQ.svc.images) {
      try {
        const img = await PQ.pdf.pageImage(ctx.doc, n);
        if (img) images = [img];
      } catch (e) {
        images = undefined;
      }
    }
    const page = ctx.x.pages[n - 1];
    return ask({
      task: "explain_page",
      json: false,
      images,
      onText,
      blocks: [
        `The learner is looking at page ${n} of the paper and pressed "Explain this page". ${images ? "An image of the page is attached; use it to read figures, tables and equations." : "Only the page's extracted text is available, so figures may be missing; say so if it matters."}`,
        `Explain the page like they are 5, then a little deeper, in short Markdown:
1. One sentence: what this page is for.
2. For each figure or table: what it shows, how to read it (axes, colors, rows), and the one thing to notice.
3. Tricky words on the page, in plain language.
At most 250 words. Only read numbers that are actually on the page.`,
        ctx.notes(),
        { label: `PAGE ${n} TEXT`, text: page ? page.text : "", flex: true },
      ],
    });
  }

  async function render(ctx, mount) {
    let read = (await ctx.part("read")) || { guides: {}, done: {}, pageNotes: {}, chats: {}, cur: null };
    read.guides = read.guides || {};
    read.done = read.done || {};
    read.pageNotes = read.pageNotes || {};
    read.chats = read.chats || {};
    const sections = ctx.x.sections;
    const required = sections.filter((s) => !s.optional);
    let alive = true;
    let cur = sections.find((s) => s.id === read.cur) || required[0] || sections[0];

    const headNote = el(`<p class="label"></p>`);
    mount.appendChild(
      PQ.quest.head(
        { eyebrow: "Stop 3 · Guided Reading", text: "Read it with Pip" },
        "Now the real paper. Pick a section: Pip tells you what it's for, what to look for, and what you can skip. Stuck on a page? Ask Pip to explain it.",
        headNote
      )
    );

    const view = el(`<div class="reading">
      <div class="pdfpane" tabindex="0" aria-label="Paper pages" style="position:relative"></div>
      <div class="companion">
        <div class="secs card"></div>
        <div class="guide card"></div>
        <div class="pagenote card guide" hidden></div>
        <div class="ask card"></div>
      </div>
    </div>`);
    mount.appendChild(view);
    const pane = view.querySelector(".pdfpane");
    const secsBox = view.querySelector(".secs");
    const guideBox = view.querySelector(".guide");
    const noteBox = view.querySelector(".pagenote");
    const askBox = view.querySelector(".ask");

    /* ----- PDF pages, rendered lazily ----- */
    const first = await ctx.doc.getPage(1);
    const vp1 = first.getViewport({ scale: 1 });
    const ratio = vp1.height / vp1.width;
    const boxes = [];
    for (let n = 1; n <= ctx.doc.numPages; n++) {
      const box = el(`<div class="pagebox" data-page="${n}">
        <canvas aria-label="Page ${n}"></canvas>
        <div class="ptools"><span class="pno">p.${n}</span><button class="btn small" type="button">Explain this page</button></div>
      </div>`);
      box.style.aspectRatio = `1 / ${ratio.toFixed(4)}`;
      box.querySelector("button").addEventListener("click", () => showPageNote(n, true));
      pane.appendChild(box);
      boxes.push(box);
    }
    const rendered = new Set();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const n = Number(e.target.getAttribute("data-page"));
          if (rendered.has(n)) continue;
          rendered.add(n);
          const width = Math.max(300, Math.min(pane.clientWidth - 28, 1000));
          PQ.pdf.renderPage(ctx.doc, n, e.target.querySelector("canvas"), width).then(() => (e.target.style.aspectRatio = "auto")).catch((err) => console.warn(err));
        }
      },
      { root: pane, rootMargin: "800px 0px" }
    );
    boxes.forEach((b) => io.observe(b));
    const goPage = (n) => {
      const b = boxes[n - 1];
      if (b) pane.scrollTo({ top: b.offsetTop - 12, behavior: "smooth" });
    };

    /* ----- Sections list ----- */
    function drawSections() {
      const doneN = required.filter((s) => read.done[s.id]).length;
      headNote.textContent = `${doneN} of ${required.length} sections read`;
      secsBox.innerHTML = `<p class="label" style="padding:4px 8px">Sections</p>`;
      for (const s of sections) {
        const b = el(`<button type="button" class="sec ${s.id === cur.id ? "cur" : ""} ${read.done[s.id] ? "read" : ""} ${s.optional ? "optional" : ""}">
          <span class="tick">${read.done[s.id] ? "✓" : ""}</span><span>${esc(s.title)}${s.optional ? " (optional)" : ""}</span><span class="pg">p.${s.page}</span></button>`);
        b.addEventListener("click", () => {
          cur = s;
          read.cur = s.id;
          ctx.savePart("read", read);
          drawSections();
          drawGuide();
          goPage(s.page);
        });
        secsBox.appendChild(b);
      }
      if (!ctx.paper.progress.read && doneN >= Math.ceil(required.length * 0.6) && doneN < required.length) {
        const fin = el(`<button class="btn small" type="button" style="margin:8px">I've finished reading</button>`);
        fin.addEventListener("click", () => ctx.complete("read"));
        secsBox.appendChild(fin);
      }
    }

    /* ----- Section guide ----- */
    async function drawGuide() {
      const s = cur;
      const g = read.guides[s.id];
      guideBox.innerHTML = `<p class="label">Section · p.${s.page}</p><h3>${esc(s.title)}</h3>`;
      if (askBox.dataset.sec !== s.id) drawAsk();
      if (!g) {
        guideBox.appendChild(PQ.quest.centerNote("Pip is skimming this section…"));
        try {
          const guide = await pip.thinking(makeGuide(ctx, s));
          read.guides[s.id] = guide;
          await ctx.savePart("read", read);
          if (alive && cur.id === s.id) drawGuide();
        } catch (err) {
          if (!alive || cur.id !== s.id) return;
          guideBox.querySelector(".center-note").replaceWith(PQ.errorBox(err, drawGuide));
        }
        return;
      }
      guideBox.appendChild(
        el(`<div style="display:grid;gap:12px">
          ${g.job ? `<p class="job">${esc(g.job)}</p>` : ""}
          ${g.lookFor.length ? `<div><p class="label">Look for</p><ul class="look">${g.lookFor.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>` : ""}
          ${g.skip.length ? `<div><p class="label">Fine to skim for now</p><ul class="skip">${g.skip.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>` : ""}
          ${g.jargon.length ? `<div><p class="label">Words to know</p><div class="jargon">${g.jargon.map((j) => `<div><b>${esc(j.term)}</b> ${esc(j.meaning)}</div>`).join("")}</div></div>` : ""}
          ${g.question ? `<p class="think"><b>Keep in mind:</b> ${esc(g.question)}</p>` : ""}
        </div>`)
      );
      const row = el(`<div class="controls"></div>`);
      const jump = el(`<button class="btn small" type="button">Go to page ${s.page}</button>`);
      jump.addEventListener("click", () => goPage(s.page));
      const mark = el(`<button class="btn small ${read.done[s.id] ? "" : "primary"}" type="button">${read.done[s.id] ? "Read ✓" : "I read this section"}</button>`);
      mark.addEventListener("click", async () => {
        read.done[s.id] = !read.done[s.id];
        await ctx.savePart("read", read);
        if (required.every((r) => read.done[r.id])) ctx.complete("read");
        else if (read.done[s.id]) {
          const next = sections.find((x) => !x.optional && !read.done[x.id] && sections.indexOf(x) > sections.indexOf(s)) || required.find((x) => !read.done[x.id]);
          if (next) {
            cur = next;
            read.cur = next.id;
            pip.say(`Nice. Next up: ${next.title}.`);
          }
        }
        drawSections();
        drawGuide();
      });
      row.append(jump, mark);
      guideBox.appendChild(row);
    }

    /* ----- Explain this page ----- */
    async function showPageNote(n, fetchIfMissing) {
      noteBox.hidden = false;
      noteBox.innerHTML = `<p class="label">Page ${n}, explained</p><div class="prose"></div>`;
      const out = noteBox.querySelector(".prose");
      noteBox.scrollIntoView({ block: "nearest", behavior: "smooth" });
      if (read.pageNotes[n]) {
        out.innerHTML = PQ.md(read.pageNotes[n]);
        return;
      }
      if (!fetchIfMissing) return;
      out.replaceWith(PQ.quest.centerNote(`Pip is looking at page ${n}…`));
      try {
        const text = await pip.thinking(
          explainPage(ctx, n, ({ text: t }) => {
            const note = noteBox.querySelector(".center-note");
            if (note) note.replaceWith(el(`<div class="prose"></div>`));
            const p = noteBox.querySelector(".prose");
            if (p) p.innerHTML = PQ.md(t);
          })
        );
        read.pageNotes[n] = text;
        await ctx.savePart("read", read);
        if (alive) noteBox.querySelector(".prose, .center-note").outerHTML = `<div class="prose">${PQ.md(text)}</div>`;
      } catch (err) {
        if (!alive) return;
        const target = noteBox.querySelector(".prose, .center-note");
        if (target) target.replaceWith(PQ.errorBox(err, () => showPageNote(n, true)));
      }
    }

    /* ----- Ask Pip (short, focused, never runs out of room) ----- */
    function drawAsk() {
      const s = cur;
      const history = read.chats[s.id] || [];
      askBox.dataset.sec = s.id;
      askBox.innerHTML = `<p class="label">Ask Pip about “${esc(s.title)}”</p>
        <div class="qa"></div>
        <form><input id="askq" type="text" autocomplete="off" placeholder="e.g. Why do they divide by the square root?" aria-label="Your question"><button class="btn small primary" type="submit">Ask</button></form>`;
      const qa = askBox.querySelector(".qa");
      history.slice(-6).forEach((t) => {
        qa.appendChild(el(`<div class="me">${esc(t.q)}</div>`));
        qa.appendChild(el(`<div class="pipsays prose">${PQ.md(t.a)}</div>`));
      });
      const form = askBox.querySelector("form");
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const input = form.querySelector("input");
        const q = input.value.trim();
        if (!q) return;
        input.value = "";
        qa.appendChild(el(`<div class="me">${esc(q)}</div>`));
        const ans = el(`<div class="pipsays prose"><p class="muted">Pip is thinking…</p></div>`);
        qa.appendChild(ans);
        const recent = history.slice(-4).map((t) => `Learner: ${t.q}\nPip: ${t.a}`).join("\n\n");
        try {
          const a = await pip.thinking(
            ask({
              task: "ask",
              json: false,
              fresh: true,
              onText: ({ text }) => (ans.innerHTML = PQ.md(text)),
              blocks: [
                `The learner is reading the section "${s.title}" and asks: "${q}"`,
                "Answer in at most 150 words of simple Markdown. Start with the plain-language answer, then one analogy. Point to the page when it helps. If the paper doesn't say, say so.",
                recent ? { label: "RECENT QUESTIONS IN THIS SECTION", text: recent, flex: true } : "",
                ctx.notes(),
                { label: `SECTION TEXT: ${s.title}`, text: ctx.x.sectionText(s), flex: true },
              ].filter(Boolean),
            })
          );
          ans.innerHTML = PQ.md(a);
          history.push({ q, a });
          read.chats[s.id] = history.slice(-20);
          await ctx.savePart("read", read);
        } catch (err) {
          ans.replaceWith(PQ.errorBox(err));
        }
      });
    }

    drawSections();
    drawGuide();
    setTimeout(() => goPage(cur.page), 60);

    return () => {
      alive = false;
      io.disconnect();
    };
  }

  PQ.stages.read = { render };
})(window.PQ);
