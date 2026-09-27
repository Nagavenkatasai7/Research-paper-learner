/* Paper Quest — Stage 2, Concept Map: the paper's ideas as a foggy map. Each idea has an
 * explanation you can zoom from "age 5" to "researcher", and lights up when you pass its check. */
"use strict";
(function (PQ) {
  const { el, esc, str, arr, ask, pip } = PQ;

  const KINDS = [
    { id: "prereq", label: "Know first", col: "What you need first" },
    { id: "core", label: "The paper's idea", col: "The paper's new ideas" },
    { id: "result", label: "What it showed", col: "What it achieved" },
  ];
  const LEVELS = ["Age 5", "Teen", "College", "Researcher"];

  async function makeMap(ctx) {
    const raw = await ask({
      task: "concept_map",
      tier: "complex",
      blocks: [
        `Build a concept map of this paper for a beginner. Pick 8 to 12 concepts:
- "prereq": ideas from outside the paper the learner must know first,
- "core": the paper's own new ideas and the parts of its method,
- "result": what the paper shows or achieves.`,
        `Reply with only JSON:
{"concepts": [{"id": "c1", "name": string (at most 4 words), "kind": "prereq" | "core" | "result",
  "levels": [four strings: the same concept explained for a 5-year-old, a teenager, a college student, and a researcher; 1 to 3 sentences each, getting more precise],
  "analogy": string (one everyday analogy),
  "where": string (where it shows up, like "Section 3.2, p.4", or "background, not in the paper"),
  "check": {"q": string, "options": [three strings], "answer": index of the right option, "why": string}}],
 "links": [{"from": "c1", "to": "c2", "label": string (at most 3 words, like "feeds into")}]}
Use 10 to 16 links, and connect every concept to at least one other.`,
        ctx.notes(),
      ],
    });
    const concepts = arr(raw && raw.concepts)
      .map((c, i) => {
        const levels = arr(c && c.levels).map((l) => str(l)).filter(Boolean);
        while (levels.length < 4) levels.push(levels[levels.length - 1] || "");
        return {
          id: str(c && c.id) || `c${i + 1}`,
          name: str(c && c.name) || `Idea ${i + 1}`,
          kind: KINDS.some((k) => k.id === (c && c.kind)) ? c.kind : "core",
          levels: levels.slice(0, 4),
          analogy: str(c && c.analogy),
          where: str(c && c.where),
          check: PQ.quest.cleanCheck(c && c.check),
        };
      })
      .slice(0, 14);
    const ids = new Set(concepts.map((c) => c.id));
    const links = arr(raw && raw.links)
      .map((l) => ({ from: str(l && l.from), to: str(l && l.to), label: str(l && l.label) }))
      .filter((l) => ids.has(l.from) && ids.has(l.to) && l.from !== l.to);
    if (concepts.length < 4) throw new PQ.AIError("invalid_json");
    return { concepts, links, lit: {}, drawings: {}, level: 0 };
  }

  /* ---------------- Layout ---------------- */
  const W = 720;
  const NW = 196;
  const NH = 58;
  const GAP = 80;
  const TOP = 50;
  const COLX = [24, 262, 500];

  function layout(map) {
    const cols = KINDS.map((k) => map.concepts.filter((c) => c.kind === k.id));
    const pos = new Map();
    const place = (list, ci) => list.forEach((c, r) => pos.set(c.id, { x: COLX[ci], y: TOP + r * GAP, col: ci }));
    place(cols[0], 0);
    // Order later columns by where their neighbours sit, so edges cross less.
    for (let ci = 1; ci < 3; ci++) {
      const score = (c) => {
        const ys = map.links
          .filter((l) => l.from === c.id || l.to === c.id)
          .map((l) => pos.get(l.from === c.id ? l.to : l.from))
          .filter((p) => p && p.col < ci)
          .map((p) => p.y);
        return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 1e6;
      };
      cols[ci].sort((a, b) => score(a) - score(b));
      place(cols[ci], ci);
    }
    const rows = Math.max(1, ...cols.map((c) => c.length));
    return { pos, height: TOP + rows * GAP };
  }

  function wrapName(name) {
    const words = name.split(/\s+/);
    const lines = [""];
    for (const w of words) {
      const cur = lines[lines.length - 1];
      if ((cur + " " + w).trim().length > 19 && cur) lines.push(w);
      else lines[lines.length - 1] = (cur + " " + w).trim();
    }
    if (lines.length > 2) lines.splice(2, lines.length, lines[1] + "…");
    return lines;
  }

  function graphSvg(map, selected) {
    const { pos, height } = layout(map);
    let edges = "";
    for (const l of map.links) {
      const a = pos.get(l.from);
      const b = pos.get(l.to);
      if (!a || !b) continue;
      let x1, y1, x2, y2, c1, c2;
      y1 = a.y + NH / 2;
      y2 = b.y + NH / 2;
      if (a.col === b.col) {
        x1 = a.x + NW;
        x2 = b.x + NW;
        c1 = `${x1 + 40} ${y1}`;
        c2 = `${x2 + 40} ${y2}`;
      } else {
        const fwd = a.col < b.col;
        x1 = fwd ? a.x + NW : a.x;
        x2 = fwd ? b.x : b.x + NW;
        const dx = (x2 - x1) / 2;
        c1 = `${x1 + dx} ${y1}`;
        c2 = `${x2 - dx} ${y2}`;
      }
      const lit = map.lit[l.from] && map.lit[l.to];
      edges += `<path class="edge ${lit ? "lit" : ""}" d="M${x1} ${y1} C${c1} ${c2} ${x2} ${y2}"><title>${esc(l.label)}</title></path>`;
    }
    let nodes = "";
    for (const c of map.concepts) {
      const p = pos.get(c.id);
      const lit = !!map.lit[c.id];
      const lines = wrapName(c.name);
      const ty = p.y + NH / 2 - (lines.length - 1) * 8 + 5;
      nodes += `<g class="node kind-${c.kind} ${lit ? "lit" : ""} ${selected === c.id ? "sel" : ""}" data-id="${esc(c.id)}" tabindex="0" role="button" aria-label="${esc(c.name)}, ${lit ? "lit up" : "still in the fog"}">
        <rect x="${p.x}" y="${p.y}" width="${NW}" height="${NH}" rx="14"/>
        <text x="${p.x + 14}" y="${ty}" class="${lit ? "" : "fogtext"}">${lines.map((ln, i) => `<tspan x="${p.x + 14}" dy="${i ? 16 : 0}">${esc(ln)}</tspan>`).join("")}</text>
        ${lit ? "" : `<text class="q" x="${p.x + NW - 20}" y="${p.y + 22}">?</text>`}
      </g>`;
    }
    const labels = KINDS.map((k, i) => `<text class="map-col-label" x="${COLX[i]}" y="28">${esc(k.col)}</text>`).join("");
    return `<svg viewBox="0 0 ${W} ${height}" role="group" aria-label="Concept map">${labels}${edges}${nodes}</svg>`;
  }

  async function render(ctx, mount) {
    let map = await ctx.part("map");
    let alive = true;
    let selected = null;

    const need = () => Math.ceil(map.concepts.length * 0.7);
    const litCount = () => map.concepts.filter((c) => map.lit[c.id]).length;

    const headNote = el(`<p class="label"></p>`);
    mount.appendChild(
      PQ.quest.head(
        { eyebrow: "Stop 2 · Concept Map", text: "Light up the map" },
        "Every idea in the paper starts in the fog. Open one, slide from “age 5” to “researcher” until it clicks, then pass its check to light it up.",
        headNote
      )
    );
    const body = el(`<div></div>`);
    mount.appendChild(body);

    async function generate() {
      PQ.clear(body).appendChild(PQ.quest.centerNote("Pip is sketching the map of ideas…"));
      try {
        map = await pip.thinking(makeMap(ctx), "Mapping the ideas…");
        await ctx.savePart("map", map);
        if (alive) draw();
      } catch (err) {
        if (!alive) return;
        PQ.clear(body).appendChild(PQ.errorBox(err, generate));
      }
    }

    function draw() {
      const n = map.concepts.length;
      headNote.textContent = `${litCount()} of ${n} ideas lit · light ${need()} to clear this stop`;
      if (!selected) {
        const firstFog = KINDS.map((k) => map.concepts.find((c) => c.kind === k.id && !map.lit[c.id])).find(Boolean);
        selected = (firstFog || map.concepts[0]).id;
      }
      const view = el(`<div class="mapwrap">
        <div>
          <div class="mapbox card">${graphSvg(map, selected)}</div>
          <div class="legend" style="margin-top:10px">
            <span><i style="border-color:var(--blue);background:var(--blue-soft)"></i>Know first</span>
            <span><i style="border-color:var(--pip);background:var(--pip-soft)"></i>The paper's idea</span>
            <span><i style="border-color:var(--coral);background:var(--coral-soft)"></i>What it showed</span>
            <span><i style="border-color:var(--line);border-style:dashed"></i>Still in the fog</span>
          </div>
        </div>
        <aside class="panel card" aria-live="polite"></aside>
      </div>`);
      view.querySelectorAll(".node").forEach((g) => {
        const pick = () => {
          selected = g.getAttribute("data-id");
          draw();
        };
        g.addEventListener("click", pick);
        g.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            pick();
          }
        });
      });
      panel(view.querySelector(".panel"));
      PQ.clear(body).appendChild(view);
    }

    function panel(box) {
      const c = map.concepts.find((cc) => cc.id === selected);
      if (!c) return;
      const kind = KINDS.find((k) => k.id === c.kind);
      const lit = !!map.lit[c.id];
      box.innerHTML = `
        <div><span class="kindpill ${c.kind}">${esc(kind.label)}</span></div>
        <h2>${esc(c.name)}</h2>
        <div class="zoom">
          <label class="label" for="lvl">Explain it for…</label>
          <input type="range" id="lvl" min="0" max="3" step="1" value="${map.level || 0}" aria-valuetext="${LEVELS[map.level || 0]}">
          <div class="ticks">${LEVELS.map((l, i) => `<span class="${i === (map.level || 0) ? "on" : ""}">${l}</span>`).join("")}</div>
        </div>
        <p class="explain"></p>
        ${c.analogy ? `<p class="analogy"><b>It's like:</b> ${esc(c.analogy)}</p>` : ""}
        ${c.where ? `<p class="label">In the paper: ${esc(c.where)}</p>` : ""}
        <div class="drawslot"></div>`;
      const explain = box.querySelector(".explain");
      const slider = box.querySelector("#lvl");
      const ticks = Array.from(box.querySelectorAll(".ticks span"));
      const setLevel = (v) => {
        explain.textContent = c.levels[v] || c.levels[0];
        ticks.forEach((t, i) => t.classList.toggle("on", i === v));
        slider.setAttribute("aria-valuetext", LEVELS[v]);
      };
      setLevel(map.level || 0);
      slider.addEventListener("input", () => setLevel(Number(slider.value)));
      slider.addEventListener("change", () => {
        map.level = Number(slider.value);
        ctx.savePart("map", map);
      });

      const slot = box.querySelector(".drawslot");
      const showDraw = () => {
        const board = el(`<div class="board"></div>`);
        PQ.clear(slot).appendChild(board);
        PQ.showDrawing(board, map.drawings[c.id], `${c.name}: ${c.analogy}`, 600);
      };
      if (map.drawings && map.drawings[c.id]) showDraw();
      else {
        const b = el(`<button class="btn small" type="button">Draw it for me</button>`);
        b.addEventListener("click", async () => {
          const board = el(`<div class="board"></div>`);
          board.appendChild(PQ.drawingPlaceholder());
          PQ.clear(slot).appendChild(board);
          try {
            const svgText = await pip.thinking(
              PQ.drawSvg("concept_svg", [
                "You are drawing one whiteboard sketch that explains a single idea from a research paper to a 5-year-old, using the analogy given.",
                `Idea: ${c.name}\nSimple explanation: ${c.levels[0]}\nAnalogy: ${c.analogy}`,
                `Reply with only one <svg> element: no prose, no code fence.
Rules: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360">, everything 20px inside the edges; marker style (stroke-width 3 to 4, round caps); colors only ink #1b2438, teal #138a80, yellow #f2b705, coral #d2502f, blue #3160c4 and soft fills #d6efec #fff3c4 #fbe1d9 #e0e8fa; <text> uses font-family="Patrick Hand, Comic Sans MS, cursive", font-size 18 to 28, at most 5 labels of at most 4 words; draw the analogy with concrete objects; wrap the drawing in 3 to 5 <g class="step"> groups in reading order; no <script>, <style>, <image>, <foreignObject>, links, filters or external references; under 6000 characters.`,
              ])
            );
            map.drawings = map.drawings || {};
            map.drawings[c.id] = svgText;
            await ctx.savePart("map", map);
            if (alive && selected === c.id) showDraw();
          } catch (err) {
            if (alive) PQ.clear(slot).appendChild(PQ.errorBox(err));
          }
        });
        slot.appendChild(b);
      }

      box.appendChild(
        PQ.quest.checkQuestion(c.check, lit ? c.check.answer : null, async (right) => {
          if (!right) {
            pip.say("Close! Slide the explanation up or down a level and read it again.", { mood: "confused" });
            return;
          }
          map.lit[c.id] = true;
          await ctx.savePart("map", map);
          pip.cheer(`${c.name} is lit!`);
          if (litCount() >= need()) ctx.complete("map");
          // Move to the next idea still in the fog after a short pause.
          setTimeout(() => {
            if (!alive) return;
            const nextFog = map.concepts.find((cc) => !map.lit[cc.id]);
            if (nextFog && selected === c.id) selected = nextFog.id;
            draw();
          }, 1400);
        })
      );
    }

    if (!map || !arr(map.concepts).length) generate();
    else draw();

    return () => {
      alive = false;
    };
  }

  PQ.stages.map = { render };
})(window.PQ);
