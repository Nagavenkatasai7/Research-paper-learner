/* Paper Quest — Stage 4, Equation X-ray: split an equation into color-coded pieces, each with a
 * plain-English label, plus a one-line "recipe" and a tiny worked example. */
"use strict";
(function (PQ) {
  const { el, esc, str, arr, ask, pip } = PQ;

  // Mid-tone hues that read on both light and dark surfaces.
  const COLORS = ["12A594", "E5663F", "4C7BE0", "C98A12", "A25BD8", "2F9E5B", "D6336C"];

  async function tex(latex, display = true) {
    const MJ = window.MathJax;
    if (!MJ || !MJ.startup) return null;
    try {
      await MJ.startup.promise;
      const node = await MJ.tex2svgPromise(latex, { display });
      if (node.querySelector('[data-mml-node="merror"], [data-mjx-error]')) return null;
      // The screen-reader copy needs MathJax's own stylesheet to stay hidden; the card carries an aria-label instead.
      node.querySelectorAll("mjx-assistive-mml").forEach((n) => n.remove());
      return node;
    } catch (e) {
      return null;
    }
  }

  async function makeXray(ctx, n, hint) {
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
    const raw = await ask({
      task: "xray",
      tier: "complex",
      images,
      blocks: [
        `X-ray the most important equations on page ${n} of the paper.${hint ? ` Focus on: ${hint}.` : ""}`,
        images
          ? "An image of the page is attached. Read the equations from the image."
          : "Only the PDF's extracted text is available and the math in it may be garbled. Reconstruct each equation as faithfully as you can, and mention any doubt in the recipe.",
        `Reply with only JSON:
{"equations": [{"name": string (what it is, in plain words), "latex": string (the full equation in LaTeX),
  "parts": [{"tex": string, "meaning": string (at most 12 kid-friendly words)}],
  "recipe": string (1 or 2 sentences: what the whole equation does, told like a cooking recipe),
  "example": string (a tiny worked example with small made-up numbers, or "")}]}
Rules: 1 to 3 equations. Split each into 3 to 7 parts in left-to-right order so that joining the parts' "tex" gives back the full equation. Every part must be valid LaTeX on its own: balanced braces, and never split inside \\frac{..}{..}, \\sqrt{..}, or a subscript or superscript group; keep such a group in one part. If the page has no real equations, reply {"equations": []}.`,
        ctx.notes(),
        { label: `PAGE ${n} TEXT`, text: page ? page.text : "", flex: true },
      ],
    });
    return arr(raw && raw.equations)
      .map((e) => ({
        id: PQ.newId("x"),
        page: n,
        name: str(e && e.name) || "Equation",
        latex: str(e && e.latex),
        parts: arr(e && e.parts)
          .map((p) => ({ tex: str(p && p.tex), meaning: str(p && p.meaning) }))
          .filter((p) => p.tex)
          .slice(0, 8),
        recipe: str(e && e.recipe),
        example: str(e && e.example),
      }))
      .filter((e) => e.latex);
  }

  async function xcard(item) {
    const card = el(`<article class="xcard card">
      <div><p class="label">Page ${item.page}</p><h3>${esc(item.name)}</h3></div>
      <div class="eq-big" aria-label="${esc(item.latex)}"></div>
      <div class="parts"></div>
      ${item.recipe ? `<p class="recipe"><b>The recipe:</b> ${esc(item.recipe)}</p>` : ""}
      ${item.example ? `<p class="example"><b>Try it with small numbers:</b> ${esc(item.example)}</p>` : ""}
    </article>`);
    const big = card.querySelector(".eq-big");
    const colored = item.parts.map((p, i) => `\\textcolor{#${COLORS[i % COLORS.length]}}{${p.tex}}`).join(" ");
    const node = (item.parts.length && (await tex(colored))) || (await tex(item.latex));
    if (node) big.appendChild(node);
    else big.appendChild(el(`<div class="tex-fallback">${esc(item.latex)}</div>`));

    const parts = card.querySelector(".parts");
    for (let i = 0; i < item.parts.length; i++) {
      const p = item.parts[i];
      const color = `#${COLORS[i % COLORS.length]}`;
      const box = el(`<div class="part" style="border-top-color:${color}"><div class="tex"></div><div class="mean">${esc(p.meaning)}</div></div>`);
      const small = await tex(`\\textcolor{#${COLORS[i % COLORS.length]}}{${p.tex}}`, false);
      box.querySelector(".tex").appendChild(small || el(`<span class="tex-fallback">${esc(p.tex)}</span>`));
      parts.appendChild(box);
    }
    return card;
  }

  async function render(ctx, mount) {
    const xray = (await ctx.part("xray")) || { items: [], scanned: {} };
    xray.items = xray.items || [];
    xray.scanned = xray.scanned || {};
    let alive = true;
    const keyEqs = ctx.brain.keyEquations || [];

    mount.appendChild(
      PQ.quest.head(
        { eyebrow: "Stop 4 · Equation X-ray", text: "See inside the math" },
        "Pip splits each important equation into colored pieces and says what every piece does. Start with the equations Pip spotted, or X-ray any page."
      )
    );
    const view = el(`<div class="xray">
      <aside class="xlist card"></aside>
      <div class="xresults" style="display:grid;gap:18px"></div>
    </div>`);
    mount.appendChild(view);
    const list = view.querySelector(".xlist");
    const results = view.querySelector(".xresults");

    async function run(n, hint) {
      if (!(n >= 1 && n <= ctx.doc.numPages)) {
        PQ.toast(`Pick a page from 1 to ${ctx.doc.numPages}.`);
        return;
      }
      const hintNote = results.querySelector(".xhint");
      if (hintNote) hintNote.remove();
      const waiting = PQ.quest.centerNote(`Pip is X-raying page ${n}…`);
      results.prepend(waiting);
      try {
        const found = await pip.thinking(makeXray(ctx, n, hint), `X-raying page ${n}…`);
        xray.scanned[n] = true;
        if (!found.length) {
          waiting.replaceWith(el(`<p class="card" style="padding:16px">Pip didn't find a real equation on page ${n}. Try another page.</p>`));
          await ctx.savePart("xray", xray);
          drawList();
          return;
        }
        xray.items = [...found, ...xray.items].slice(0, 30);
        await ctx.savePart("xray", xray);
        if (!alive) return;
        const cards = await Promise.all(found.map(xcard));
        waiting.replaceWith(...cards);
        drawList();
        ctx.complete("xray");
      } catch (err) {
        if (alive) waiting.replaceWith(PQ.errorBox(err, () => run(n, hint)));
      }
    }

    function drawList() {
      list.innerHTML = `<p class="label">Equations Pip spotted</p>`;
      if (!keyEqs.length) {
        list.appendChild(el(`<p class="muted" style="font-size:14.5px">Pip didn't flag any key equations in this paper. X-ray a page you're curious about, or skip this stop.</p>`));
      }
      keyEqs.forEach((k) => {
        const done = xray.items.some((it) => it.page === k.page);
        const b = el(`<button class="xpick ${done ? "done" : ""}" type="button"><span class="pg">p.${k.page}</span><span>${esc(k.what || "Equation")}</span><span class="label">${done ? "Done" : "X-ray"}</span></button>`);
        b.addEventListener("click", () => run(k.page, k.what));
        list.appendChild(b);
      });
      const pick = el(`<form class="xpage"><label class="label" for="xpg">Any page</label><input id="xpg" type="number" min="1" max="${ctx.doc.numPages}" value="1"><button class="btn small" type="submit">X-ray it</button></form>`);
      pick.addEventListener("submit", (e) => {
        e.preventDefault();
        run(Number(pick.querySelector("input").value));
      });
      list.appendChild(pick);
      if (!ctx.paper.progress.xray) {
        const skip = el(`<button class="linkish" type="button" style="justify-self:start;margin-top:6px">This paper has no math to X-ray. Skip this stop.</button>`);
        skip.addEventListener("click", () => ctx.complete("xray"));
        list.appendChild(skip);
      }
    }

    drawList();
    if (xray.items.length) {
      for (const item of xray.items) {
        if (!alive) break;
        results.appendChild(await xcard(item));
      }
    } else {
      const note = PQ.quest.centerNote(keyEqs.length ? "Pick an equation on the left to X-ray it." : "Pick a page on the left to X-ray it.", "idle");
      note.classList.add("xhint");
      results.appendChild(note);
    }

    return () => {
      alive = false;
    };
  }

  PQ.stages.xray = { render };
})(window.PQ);
