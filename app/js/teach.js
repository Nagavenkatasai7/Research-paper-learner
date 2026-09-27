/* Paper Quest — Stage 5, Teach Pip: the roles flip. Pip plays a curious 5-year-old, the learner
 * explains the paper, and Pip tracks which key ideas have really been taught (the Feynman technique). */
"use strict";
(function (PQ) {
  const { el, esc, str, arr, ask, pip } = PQ;

  const MAX_TURNS_SENT = 12;

  async function render(ctx, mount) {
    const ideas = ctx.brain.keyIdeas || [];
    let teach = (await ctx.part("teach")) || null;
    if (!teach || !arr(teach.turns).length) {
      teach = {
        turns: [
          {
            role: "pip",
            text: `Hi! Today I'm five years old. I heard you read a paper called “${ctx.brain.title}”. What's it about? Use small words please!`,
            mood: "curious",
          },
        ],
        covered: {},
        partial: {},
      };
    }
    teach.covered = teach.covered || {};
    teach.partial = teach.partial || {};
    let alive = true;
    let busy = false;

    const score = () => {
      if (!ideas.length) return 0;
      const pts = ideas.reduce((n, k) => n + (teach.covered[k.id] ? 1 : teach.partial[k.id] ? 0.5 : 0), 0);
      return Math.round((pts / ideas.length) * 100);
    };

    mount.appendChild(
      PQ.quest.head(
        { eyebrow: "Stop 5 · Teach Pip", text: "Now you're the teacher" },
        "Explain the paper to Pip, who is five today. Pip keeps asking “but why?” until every key idea is clear. Reach 80% to clear this stop."
      )
    );
    const view = el(`<div class="teach">
      <aside class="ideas card"></aside>
      <section class="chat card" aria-label="Conversation with Pip">
        <div class="thread"></div>
        <form class="compose">
          <label class="label" for="teach-input">Your explanation</label>
          <textarea id="teach-input" placeholder="Explain it the way you'd tell a curious kid…"></textarea>
          <div class="row">
            <button class="btn small ghost" type="button" data-act="hint">I'm stuck, give me a hint</button>
            <button class="btn primary" type="submit">Explain to Pip</button>
          </div>
        </form>
      </section>
    </div>`);
    mount.appendChild(view);
    const side = view.querySelector(".ideas");
    const thread = view.querySelector(".thread");
    const form = view.querySelector("form");
    const input = form.querySelector("textarea");

    function drawIdeas() {
      const s = score();
      side.innerHTML = `
        <p class="label">Pip understands</p>
        <div style="display:flex;align-items:baseline;gap:8px"><span style="font:800 36px var(--f-display)">${s}%</span><span class="muted">of the paper</span></div>
        <div class="meter"><i style="width:${s}%"></i></div>
        <p class="label" style="margin-top:6px">Ideas to teach</p>`;
      ideas.forEach((k) => {
        const st = teach.covered[k.id] ? "covered" : teach.partial[k.id] ? "partial" : "";
        side.appendChild(el(`<div class="idea ${st}"><span class="st" aria-hidden="true"></span><span>${esc(k.idea)}<span class="muted" style="font-size:12px"> · ${st === "covered" ? "taught" : st === "partial" ? "halfway" : "not yet"}</span></span></div>`));
      });
    }

    function drawThread() {
      thread.innerHTML = "";
      teach.turns.forEach((t) => {
        if (t.role === "you") {
          thread.appendChild(el(`<div class="msg you"><div class="bubble">${esc(t.text)}</div></div>`));
        } else if (t.role === "coach") {
          thread.appendChild(el(`<div class="msg"><span></span><div class="coach"><b>Coach note:</b> ${esc(t.text)}</div></div>`));
        } else {
          const m = el(`<div class="msg"><div class="bot">${pip.svg(t.mood === "confused" ? "confused" : t.mood === "happy" ? "happy" : "")}</div><div class="bubble">${esc(t.text)}</div></div>`);
          thread.appendChild(m);
        }
      });
      const last = thread.lastElementChild;
      if (last) last.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }

    function transcript() {
      return teach.turns
        .filter((t) => t.role !== "coach")
        .slice(-MAX_TURNS_SENT)
        .map((t) => `${t.role === "you" ? "Learner" : "Pip"}: ${t.text}`)
        .join("\n");
    }

    async function send(text) {
      if (busy) return;
      busy = true;
      teach.turns.push({ role: "you", text });
      drawThread();
      const typing = el(`<div class="msg"><div class="bot">${pip.svg("think")}</div><div class="bubble muted">Pip is thinking…</div></div>`);
      thread.appendChild(typing);
      try {
        const raw = await pip.thinking(
          ask({
            task: "teach",
            fresh: true,
            blocks: [
              "Role-play: you are Pip, a friendly robot pretending to be a curious 5-year-old who is being taught this paper by the learner. You secretly know the paper (notes below) but act like you don't. Your job is to find the gaps in the learner's explanation, not to teach.",
              `Key ideas the learner should get across:\n${ideas.map((k) => `${k.id}: ${k.idea}`).join("\n")}\nAlready taught: ${Object.keys(teach.covered).join(", ") || "none"}. Halfway: ${Object.keys(teach.partial).join(", ") || "none"}.`,
              `Reply with only JSON:
{"reply": string (as a 5-year-old: 1 to 3 short sentences reacting to what the learner just said, then exactly ONE curious "why" or "how" question aimed at an idea that isn't taught yet; never lecture or give the answer),
 "covered": [ids the learner has now explained correctly, counting earlier turns too],
 "partial": [ids explained only partly],
 "mixup": string (if the learner said something wrong about the paper, a short, kind correction written to the learner; otherwise ""),
 "mood": "happy" | "curious" | "confused"}`,
              { label: "CONVERSATION SO FAR", text: transcript(), flex: true },
              ctx.notes(),
            ],
          })
        );
        const ids = new Set(ideas.map((k) => k.id));
        arr(raw && raw.covered).forEach((id) => {
          if (ids.has(String(id))) {
            teach.covered[String(id)] = true;
            delete teach.partial[String(id)];
          }
        });
        arr(raw && raw.partial).forEach((id) => {
          if (ids.has(String(id)) && !teach.covered[String(id)]) teach.partial[String(id)] = true;
        });
        const reply = str(raw && raw.reply) || "Ooh! Can you tell me more?";
        const mood = ["happy", "curious", "confused"].includes(raw && raw.mood) ? raw.mood : "curious";
        teach.turns.push({ role: "pip", text: reply, mood });
        const mixup = str(raw && raw.mixup);
        if (mixup) teach.turns.push({ role: "coach", text: mixup });
        teach.turns = teach.turns.slice(-80);
        await ctx.savePart("teach", teach);
        if (!alive) return;
        drawThread();
        drawIdeas();
        if (score() >= 80 && !ctx.paper.progress.teach) {
          pip.cheer("You taught me the whole paper!");
          ctx.complete("teach");
        }
      } catch (err) {
        typing.remove();
        teach.turns.pop();
        input.value = text;
        thread.appendChild(PQ.errorBox(err));
      } finally {
        busy = false;
      }
    }

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text || busy) return;
      input.value = "";
      send(text);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) form.requestSubmit();
    });
    view.querySelector('[data-act="hint"]').addEventListener("click", async (e) => {
      const target = ideas.find((k) => !teach.covered[k.id]);
      if (!target) return PQ.toast("You've taught every idea already!");
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const hint = await pip.thinking(
          ask({
            task: "hint",
            tier: "quick",
            json: false,
            blocks: [
              `The learner is trying to explain this idea from the paper and is stuck: "${target.idea}". Give a one- or two-sentence nudge that points them in the right direction without giving the full answer. Mention where in the paper to look if you know.`,
              ctx.notes(),
            ],
          })
        );
        teach.turns.push({ role: "coach", text: `Hint: ${str(hint)}` });
        await ctx.savePart("teach", teach);
        drawThread();
      } catch (err) {
        thread.appendChild(PQ.errorBox(err));
      } finally {
        btn.disabled = false;
      }
    });

    drawIdeas();
    drawThread();
    return () => {
      alive = false;
    };
  }

  PQ.stages.teach = { render };
})(window.PQ);
