/* Paper Quest — Stage 1, Story Mode: the paper as a narrated whiteboard cartoon,
 * with a quick check after every scene. */
"use strict";
(function (PQ) {
  const { el, esc, str, arr, ask, pip } = PQ;

  const ARC = ["The world before", "The problem", "The big idea", "How it works", "Did it work?", "The catch"];

  async function makeScript(ctx) {
    const raw = await ask({
      task: "story_script",
      tier: "complex",
      blocks: [
        `Turn this paper into a short explainer cartoon for a 5-year-old, told as a story. Use 6 to 8 scenes following this arc: ${ARC.map((a) => `"${a}"`).join(" → ")}. "How it works" may take one to three scenes, one step each.`,
        `Reply with only JSON:
{"scenes": [{"act": string (one of the arc names), "title": string (at most 6 words),
  "narration": string (what Pip says out loud: 1 to 3 short sentences, at most 45 words, with one everyday analogy, true to the paper),
  "visual": string (what to draw on a whiteboard: concrete objects, characters and arrows acting out the narration, with at most 5 short labels),
  "check": {"q": string, "options": [three strings], "answer": index of the right option, "why": string (one sentence)}}]}
Each check tests the idea of its own scene and has believable wrong options.`,
        ctx.notes(),
      ],
    });
    const scenes = arr(raw && raw.scenes)
      .map((s) => ({
        act: str(s && s.act) || "The story",
        title: str(s && s.title) || "Scene",
        narration: str(s && s.narration),
        visual: str(s && s.visual),
        check: PQ.quest.cleanCheck(s && s.check),
      }))
      .filter((s) => s.narration)
      .slice(0, 9);
    if (scenes.length < 3) throw new PQ.AIError("invalid_json");
    return scenes;
  }

  function drawPrompt(scene, oneLiner) {
    return [
      "You are drawing one whiteboard sketch for a kids' explainer cartoon about a research paper.",
      `Paper in one line: ${oneLiner}\nScene: ${scene.act} — ${scene.title}\nNarration: ${scene.narration}\nWhat to draw: ${scene.visual}`,
      `Reply with only one <svg> element: no prose, no code fence.
Rules:
- <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360">. Keep everything at least 20px inside the edges.
- Marker-on-whiteboard style: stroke-width 3 to 4, stroke-linecap="round", stroke-linejoin="round". Simple shapes; a little wobble is welcome.
- Colors only from: ink #1b2438, teal #138a80, yellow #f2b705, coral #d2502f, blue #3160c4, and soft fills #d6efec #fff3c4 #fbe1d9 #e0e8fa. Leave the background transparent.
- Text: <text> with font-family="Patrick Hand, Comic Sans MS, cursive", font-size 18 to 28, fill="#1b2438". At most 6 labels of at most 4 words each. No sentences.
- Draw friendly, concrete things (people, robots, books, boxes, pipes, magnifying glasses, arrows) that act out the idea, not just labeled boxes.
- Wrap the drawing in 3 to 6 <g class="step"> groups, in the order they should appear while the narration is read aloud.
- No <script>, <style>, <image>, <foreignObject>, links, filters, or external references. Stay under 6000 characters.`,
    ];
  }

  /** Draw a whiteboard SVG for any subject; shared with the concept map's "Draw it". */
  async function draw(task, blocks) {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const text = await ask({ task, json: false, blocks, fresh: attempt > 0 });
        const node = PQ.sanitizeSvg(text);
        if (node) return new XMLSerializer().serializeToString(node);
        lastErr = new PQ.AIError("invalid_json");
      } catch (e) {
        lastErr = e;
        if (e.code !== "invalid_json" && e.code !== "empty_completion") break;
      }
    }
    throw lastErr;
  }
  PQ.drawSvg = draw;

  /** Put a stored SVG on a board element and reveal its steps one by one. */
  function showDrawing(board, svgText, label, stepMs = 900) {
    const node = PQ.sanitizeSvg(svgText, label);
    PQ.clear(board);
    if (!node) {
      board.appendChild(el(`<div class="drawing-msg">Pip's drawing smudged. Try Redraw.</div>`));
      return;
    }
    node.classList.add("drawing");
    const steps = Array.from(node.querySelectorAll(".step"));
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    board.appendChild(node);
    if (!steps.length || reduce) return;
    node.classList.add("animate");
    steps.forEach((s, i) => setTimeout(() => s.classList.add("shown"), 150 + i * stepMs));
  }
  PQ.showDrawing = showDrawing;

  function drawingPlaceholder(text = "Pip is drawing…") {
    return el(`<div class="drawing-msg"><div><svg class="scribble" viewBox="0 0 120 40" aria-hidden="true"><path d="M5 30 C 25 5, 35 5, 45 25 S 70 40, 80 15 S 105 5, 115 25"/></svg><div>${esc(text)}</div></div></div>`);
  }
  PQ.drawingPlaceholder = drawingPlaceholder;

  async function render(ctx, mount) {
    const oneLiner = ctx.brain.oneLiner;
    let story = (await ctx.part("story")) || null;
    let alive = true;
    const inflight = new Map();
    let voiceOn = !pip.speech.muted;

    mount.appendChild(
      PQ.quest.head(
        { eyebrow: "Stop 1 · Story Mode", text: "The paper as a story" },
        "Pip acts the paper out on a whiteboard, one scene at a time. Answer the quick check to move to the next scene."
      )
    );
    const body = el(`<div></div>`);
    mount.appendChild(body);

    function intro(err) {
      const box = el(`<div class="gate card">
        <div class="bot">${pip.svg()}</div>
        <h2>Ready for the story?</h2>
        <p class="muted">Pip will turn “${esc(ctx.brain.title)}” into a short cartoon with ${pip.speech.supported ? "narration you can hear" : "narration"}. It takes about a minute to write.</p>
        <button class="btn primary" type="button">Make my story</button>
      </div>`);
      if (err) box.appendChild(PQ.errorBox(err));
      box.querySelector("button").addEventListener("click", generate);
      PQ.clear(body).appendChild(box);
    }

    async function generate() {
      PQ.clear(body).appendChild(PQ.quest.centerNote("Pip is writing the story script…"));
      try {
        const scenes = await pip.thinking(makeScript(ctx), "Writing your story…");
        story = { scenes, svgs: {}, answers: {}, at: 0 };
        await ctx.savePart("story", story);
        if (alive) show(0, true);
      } catch (err) {
        if (alive) intro(err);
      }
    }

    function ensureSvg(i) {
      if (story.svgs[i]) return Promise.resolve(story.svgs[i]);
      if (inflight.has(i)) return inflight.get(i);
      const p = draw("scene_svg", drawPrompt(story.scenes[i], oneLiner))
        .then(async (svgText) => {
          story.svgs[i] = svgText;
          await ctx.savePart("story", story);
          return svgText;
        })
        .finally(() => inflight.delete(i));
      inflight.set(i, p);
      return p;
    }

    function show(i, speak) {
      if (!alive) return;
      pip.speech.stop();
      story.at = i;
      const scene = story.scenes[i];
      const n = story.scenes.length;
      const last = i === n - 1;
      const answered = story.answers[i] === scene.check.answer;

      const view = el(`<div class="story">
        <div>
          <div class="board" aria-live="off"></div>
          <div class="filmstrip" aria-label="Scenes"></div>
        </div>
        <div class="scene-side">
          <p class="act">Scene ${i + 1} of ${n} · ${esc(scene.act)}</p>
          <h2>${esc(scene.title)}</h2>
          <div class="narration"><div class="bot">${pip.svg()}</div><p>${esc(scene.narration)}</p></div>
          <div class="controls">
            <button class="btn small" type="button" data-act="back" ${i === 0 ? "disabled" : ""}>← Back</button>
            ${pip.speech.supported ? `<button class="btn small" type="button" data-act="replay">Replay voice</button><button class="btn small ghost" type="button" data-act="voice" aria-pressed="${voiceOn}">Voice: ${voiceOn ? "on" : "off"}</button>` : ""}
            <button class="btn small ghost" type="button" data-act="redraw">Redraw</button>
            <button class="btn small primary" type="button" data-act="next" ${answered ? "" : "disabled"}>${last ? (ctx.paper.progress.story ? "Go to the Map →" : "Finish story") : "Next scene →"}</button>
          </div>
        </div>
      </div>`);

      const film = view.querySelector(".filmstrip");
      story.scenes.forEach((s, j) => {
        const ok = story.answers[j] === s.check.answer;
        const reachable = j <= i || ok || story.scenes.slice(0, j).every((ss, k) => story.answers[k] === ss.check.answer);
        const b = el(`<button type="button" class="${ok ? "ok" : j < i ? "seen" : ""} ${j === i ? "cur" : ""}" aria-label="Scene ${j + 1}${ok ? ", done" : ""}" ${reachable ? "" : "disabled"}></button>`);
        b.addEventListener("click", () => show(j, true));
        film.appendChild(b);
      });

      const side = view.querySelector(".scene-side");
      const nextBtn = view.querySelector('[data-act="next"]');
      side.appendChild(
        PQ.quest.checkQuestion(scene.check, story.answers[i], async (right, choice) => {
          story.answers[i] = choice;
          if (right) {
            nextBtn.disabled = false;
            pip.setMood(side.querySelector(".narration svg.pip"), "happy");
            if (story.scenes.every((s, j) => story.answers[j] === s.check.answer)) ctx.complete("story");
          } else {
            pip.setMood(side.querySelector(".narration svg.pip"), "confused");
          }
          await ctx.savePart("story", story);
        })
      );

      view.querySelector('[data-act="back"]').addEventListener("click", () => show(i - 1, true));
      nextBtn.addEventListener("click", () => {
        if (!last) show(i + 1, true);
        else if (ctx.paper.progress.story) ctx.go("map");
        else PQ.toast("Answer every scene's check to finish the story.");
      });
      const voice = view.querySelector('[data-act="voice"]');
      const setVoice = (on) => {
        voiceOn = on;
        pip.speech.muted = !on;
        if (voice) {
          voice.setAttribute("aria-pressed", String(on));
          voice.textContent = `Voice: ${on ? "on" : "off"}`;
        }
        if (!on) pip.speech.stop();
      };
      if (voice) voice.addEventListener("click", () => setVoice(!voiceOn));
      const replay = view.querySelector('[data-act="replay"]');
      if (replay)
        replay.addEventListener("click", () => {
          if (!voiceOn) setVoice(true);
          narrate();
        });
      view.querySelector('[data-act="redraw"]').addEventListener("click", () => {
        delete story.svgs[i];
        paint();
      });

      PQ.clear(body).appendChild(view);
      ctx.savePart("story", story);

      const board = view.querySelector(".board");
      const talker = side.querySelector(".narration svg.pip");
      function narrate() {
        if (!voiceOn) return;
        pip.speech.speak(scene.narration, {
          onStart: () => pip.setMood(talker, "talk"),
          onEnd: () => pip.setMood(talker, "idle"),
        });
      }
      function paint() {
        board.replaceChildren(drawingPlaceholder());
        ensureSvg(i)
          .then((svgText) => {
            if (!alive || story.at !== i) return;
            showDrawing(board, svgText, `${scene.title}: ${scene.visual}`, Math.max(700, (scene.narration.length * 60) / 5));
            // Draw the next scene in the background so it's ready.
            if (i + 1 < n && !story.svgs[i + 1]) ensureSvg(i + 1).catch(() => {});
          })
          .catch((err) => {
            if (!alive || story.at !== i) return;
            board.replaceChildren(el(`<div class="drawing-msg">${esc(err.message)}</div>`));
          });
      }
      paint();
      if (speak) narrate();
    }

    if (!story || !arr(story.scenes).length) intro();
    else show(Math.min(story.at || 0, story.scenes.length - 1), false);

    return () => {
      alive = false;
      pip.speech.stop();
    };
  }

  PQ.stages.story = { render };
})(window.PQ);
