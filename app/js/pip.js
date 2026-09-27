/* Paper Quest — Pip, the robot tutor: the avatar, its moods, the docked speech bubble,
 * and read-aloud narration (used by Story Mode only). */
"use strict";
(function (PQ) {
  const { el, esc } = PQ;

  /** The robot, drawn once as inline SVG. Moods are CSS classes on the <svg>. */
  function svg(extraClass = "") {
    return `
<svg class="pip ${extraClass}" viewBox="0 0 120 150" aria-hidden="true" focusable="false">
  <ellipse cx="60" cy="144" rx="30" ry="4" fill="currentColor" opacity=".12"/>
  <g class="bob">
    <g class="head">
      <line x1="60" y1="22" x2="60" y2="9" stroke="var(--ink)" stroke-width="3" stroke-linecap="round"/>
      <circle class="bulb" cx="60" cy="8" r="5.5" fill="var(--hi)" stroke="var(--ink)" stroke-width="2"/>
      <rect x="10" y="44" width="10" height="20" rx="4" fill="var(--pip-deep)"/>
      <rect x="100" y="44" width="10" height="20" rx="4" fill="var(--pip-deep)"/>
      <rect x="17" y="22" width="86" height="66" rx="24" fill="var(--pip)" stroke="var(--ink)" stroke-width="3"/>
      <rect x="28" y="34" width="64" height="42" rx="15" fill="var(--visor)"/>
      <g class="gaze">
        <ellipse class="eye-open l" cx="47" cy="53" rx="6.5" ry="7.5" fill="var(--glow)"/>
        <ellipse class="eye-open r" cx="73" cy="53" rx="6.5" ry="7.5" fill="var(--glow)"/>
        <path class="eye-happy" d="M40 56 q7 -9 14 0 M66 56 q7 -9 14 0" stroke="var(--glow)" stroke-width="3.5" fill="none" stroke-linecap="round"/>
        <rect class="mouth" x="53" y="65" width="14" height="3.5" rx="1.75" fill="var(--glow)"/>
      </g>
    </g>
    <path class="arm-l" d="M33 104 q-14 6 -16 18" stroke="var(--ink)" stroke-width="3.5" fill="none" stroke-linecap="round"/>
    <path class="arm-r" d="M87 104 q14 6 16 18" stroke="var(--ink)" stroke-width="3.5" fill="none" stroke-linecap="round"/>
    <rect x="31" y="92" width="58" height="42" rx="14" fill="var(--pip-deep)" stroke="var(--ink)" stroke-width="3"/>
    <circle cx="60" cy="112" r="7" fill="var(--hi)" stroke="var(--ink)" stroke-width="2"/>
  </g>
</svg>`;
  }

  const MOODS = ["think", "talk", "happy", "confused"];
  /** Set the mood on every Pip inside `scope` (or one svg). mood: idle|think|talk|happy|confused */
  function setMood(target, mood) {
    const svgs = target && target.classList && target.classList.contains("pip") ? [target] : Array.from((target || document).querySelectorAll("svg.pip"));
    for (const s of svgs) {
      MOODS.forEach((m) => s.classList.remove(m));
      if (mood && mood !== "idle") {
        // restart one-shot animations (happy) by forcing a reflow
        void s.getBoundingClientRect();
        s.classList.add(mood);
      }
    }
  }

  /* ---------------- The docked companion ---------------- */
  let dock;
  let bubbleTimer;
  let busy = 0;
  function mountDock() {
    dock = document.getElementById("pip-dock");
    dock.innerHTML = `<div class="bot">${svg()}</div>`;
  }
  /** Say a short line from the docked Pip. opts: {mood, sticky, ms} */
  function say(text, opts = {}) {
    if (!dock) return;
    let bubble = dock.querySelector(".pip-bubble");
    if (!bubble) {
      bubble = el(`<div class="pip-bubble" role="status"></div>`);
      dock.appendChild(bubble);
    }
    bubble.innerHTML = `<div class="row"><span>${esc(text)}</span></div>`;
    bubble.hidden = false;
    setMood(dock, opts.mood || (busy ? "think" : "idle"));
    clearTimeout(bubbleTimer);
    if (!opts.sticky) {
      bubbleTimer = setTimeout(() => {
        bubble.hidden = true;
        if (!busy) setMood(dock, "idle");
      }, opts.ms || 6000);
    }
  }
  function hush() {
    const bubble = dock && dock.querySelector(".pip-bubble");
    if (bubble) bubble.hidden = true;
  }
  /** Wrap a promise so the docked Pip looks busy while it runs. */
  async function thinking(promise, line) {
    busy++;
    setMood(dock, "think");
    if (line) say(line, { mood: "think", sticky: true });
    try {
      return await promise;
    } finally {
      busy = Math.max(0, busy - 1);
      if (!busy) {
        setMood(dock, "idle");
        if (line) hush();
      }
    }
  }
  function cheer(line) {
    say(line, { mood: "happy", ms: 4500 });
  }
  function showDock(show) {
    if (dock) dock.hidden = !show;
  }

  /* ---------------- Read-aloud (Story Mode) ---------------- */
  // Best-sounding voices first: neural/"Natural" voices, then Google's, then Apple's premium ones.
  const VOICE_RANK = [/natural|neural/i, /online/i, /google/i, /premium|enhanced/i, /samantha|aria|jenny|ava|allison|zira|serena|karen|moira|susan/i];
  const voiceScore = (v) => {
    const i = VOICE_RANK.findIndex((re) => re.test(v.name));
    return (i < 0 ? VOICE_RANK.length : i) * 2 + (/^en[-_]US/i.test(v.lang) ? 0 : 1);
  };
  const VOICE_KEY = "pq:voice";

  const speech = {
    supported: typeof window.speechSynthesis !== "undefined" && typeof window.SpeechSynthesisUtterance !== "undefined",
    muted: false,
    voice: null,
    /** English voices this browser offers, best-sounding first. */
    voices() {
      if (!this.supported) return [];
      const all = window.speechSynthesis.getVoices() || [];
      const en = all.filter((v) => /^en[-_]/i.test(v.lang));
      return (en.length ? en : all).slice().sort((a, b) => voiceScore(a) - voiceScore(b) || a.name.localeCompare(b.name));
    },
    pickVoice() {
      const list = this.voices();
      let saved = null;
      try {
        saved = localStorage.getItem(VOICE_KEY);
      } catch (e) {
        saved = null;
      }
      this.voice = (saved && list.find((v) => v.name === saved)) || list[0] || null;
      return this.voice;
    },
    /** Remember the viewer's chosen voice on this device. */
    setVoice(name) {
      this.voice = this.voices().find((v) => v.name === name) || this.voice;
      try {
        localStorage.setItem(VOICE_KEY, name);
      } catch (e) {
        /* per-device convenience only */
      }
    },
    /** Speak text; resolves when finished (or immediately when muted/unsupported). */
    speak(text, { onStart, onEnd, onWord } = {}) {
      return new Promise((resolve) => {
        let finished = false;
        const done = () => {
          if (finished) return;
          finished = true;
          if (onEnd) onEnd();
          resolve();
        };
        if (!this.supported || this.muted || !text) return done();
        try {
          window.speechSynthesis.cancel();
          const u = new SpeechSynthesisUtterance(text);
          const v = this.voice || this.pickVoice();
          if (v) u.voice = v;
          u.rate = 1;
          u.pitch = 1.25; // Pip's cute-robot voice
          u.onstart = () => onStart && onStart();
          u.onboundary = () => onWord && onWord();
          u.onend = done;
          u.onerror = done;
          window.speechSynthesis.speak(u);
          // Some browsers never fire onend for long text; give up after a generous wait.
          setTimeout(done, Math.max(8000, text.length * 110));
        } catch (e) {
          done();
        }
      });
    },
    stop() {
      if (this.supported) {
        try {
          window.speechSynthesis.cancel();
        } catch (e) {
          /* ignore */
        }
      }
    },
  };
  if (speech.supported) {
    try {
      window.speechSynthesis.onvoiceschanged = () => speech.pickVoice();
    } catch (e) {
      /* ignore */
    }
  }

  PQ.pip = { svg, setMood, mountDock, say, hush, thinking, cheer, showDock, speech };
})(window.PQ);
