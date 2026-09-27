# Paper Quest

A study app for a **100 papers in 100 days** challenge. Drop in a research paper (PDF) and
Pip, a small robot tutor, turns it into a one-day quest. You don't get a summary to read. You
*play through* the paper, with each stop building on the one before:

| Stop | What happens | Why it helps |
| --- | --- | --- |
| 1. **Story** | The paper becomes a 6–8 scene whiteboard cartoon (world before → problem → big idea → how it works → did it work? → the catch). Pip narrates each scene aloud, and a quick check gates the next scene. | You hold the whole shape of the paper before reading a page. |
| 2. **Concept Map** | Every idea sits in "fog" on a map (what you need first → the paper's new ideas → what it achieved). A slider explains each idea for an age 5 reader, a teen, a college student or a researcher. Passing an idea's check lights it up. | Prerequisites stop being a wall, and the map shows how ideas depend on each other. |
| 3. **Guided Reading** | The real PDF, with a companion for each section: what it's for, what to look for, what to skip, and words to know. **Explain this page** sends the page image to Claude so figures and tables get explained too. **Ask Pip** answers questions about the section. | You read the actual paper, but never alone. |
| 4. **Equation X-ray** | Key equations are split into color-coded pieces, each labeled in plain English, plus a one-line "recipe" and a tiny worked example. | Math stops being a block of symbols. |
| 5. **Teach Pip** | The roles flip. Pip plays a curious 5-year-old, you explain the paper, and Pip keeps asking "but why?". A meter tracks which key ideas you've really taught, and coach notes flag mix-ups. | This is the Feynman technique: explaining it is how you find what you don't understand yet. |
| 6. **Brainstorm** | Sticky notes with research ideas, real-world uses, and connections to papers you've already read. Keep, expand, or combine them. | It turns reading into ideas of your own. |

Stops unlock in order (there's a "skip ahead anyway" escape hatch). The library shows each paper
as **Day N** with its progress, plus a 100-day grid.

## How it runs: no API key needed

Paper Quest is a **claude.ai artifact**, a private web page hosted on claude.ai. Every AI call
goes through the artifact runtime's `sample` capability, so it runs on **your own Claude
subscription** and counts against your plan's normal usage limits. There is no API key and no server.

| Capability | Used for |
| --- | --- |
| `sample` | Every Claude call. The tier is `complex` for study notes, the story script, the concept map and X-rays, `default` for everything else, and `quick` for hints. |
| `db` | Your library and all quest progress, saved under your **private** `data/users/<you>/…` path. Nobody else who opens the link can see it. |
| `assets` | A copy of each PDF, so the paper opens on any device. |
| `user` | Your viewer id, which is what makes the private path possible. |

### Why the chat never hits "conversation too long"

A long chat usually fails because one conversation keeps growing until it hits the context limit.
Paper Quest never grows a conversation:

1. When you add a paper, Pip reads it once and writes dense **study notes** (a 900–1600-word
   digest with page tags, the key ideas, and the key equations). Very long papers are condensed
   chunk by chunk first.
2. Every later request is a fresh, bounded prompt: the study notes, plus only the section or page
   you're on, plus the last few turns. The limit is 64 KiB per request, and `buildPrompt` in
   `app/js/core.js` trims each piece to fit.
3. Your full history (questions, teach-back turns, brainstorm notes) is saved to storage, not
   re-sent. You can keep asking questions all day.

## Using it

1. Open the published artifact from claude.ai while signed in. The first time Pip thinks, Claude
   asks you to allow the page to use your account.
2. Drop a PDF on **Start a new quest**. PDFs with selectable text work best; scanned PDFs have no
   text for Pip to read.
3. Follow the stops. Story Mode narration uses your browser's built-in voice, and you can turn
   it off with **Voice: on/off**.

If you open the page outside claude.ai, the library and PDFs still load, but Pip can't think. A
banner says so.

## Project layout

```
app/
  paper-quest.html   page shell: tokens, styles, and script tags (the platform adds <html>/<head>/<body>)
  js/core.js         helpers, platform services, storage (db + IndexedDB fallback), Claude wrapper, SVG sanitizer
  js/pip.js          the robot: SVG avatar, moods, docked speech bubble, read-aloud
  js/pdf.js          pdf.js: text extraction (two-column aware), section detection, page rendering
  js/library.js      library view, PDF intake, study-notes ("brain") builder
  js/quest.js        quest shell: six-stop track, locks, shared stage context
  js/story.js … js/brainstorm.js   one file per stop
  js/main.js         boot and routing
dev/
  mock-claude.js     test double for the claude.ai runtime (canned answers, in-memory db/assets)
  smoke.mjs          Playwright end-to-end test that plays through all six stops
```

Libraries load from cdnjs: pdf.js 3.11.174 and MathJax 3.2.2 (`tex-svg-full`). Fonts come from Google Fonts.

## Development

```bash
cd dev
npm install
node smoke.mjs            # screenshots go to dev/screenshots/
```

The smoke test builds a small fake paper PDF, uploads it, and plays every stop against the mock
runtime. It checks that:

* model-drawn SVGs are sanitized,
* PDF pages don't overlap,
* a bad equation split falls back cleanly,
* no prompt exceeds 64 KiB,
* data lands under the viewer's private path,
* the page never scrolls sideways at phone width.

## Hosting outside claude.ai (Vercel)

`node scripts/build-web.mjs` builds a standalone static site in `dist/`, and `vercel.json` points
Vercel at that build. Outside claude.ai there is no `window.claude` runtime, so the site shows the
full interface and stores your library in the browser, but **Pip can't think there**: stops that
need Claude show a note instead. Use the claude.ai artifact for real study sessions.

### Free models through OpenRouter (Vercel site only)

On any copy hosted outside claude.ai, the library shows a **Pip's brain** panel. Paste your own
OpenRouter key and pick a free model (only `:free`/zero-price models are listed), and Pip thinks
through OpenRouter. The key is kept in that browser's localStorage and sent only to openrouter.ai.
It is never part of the code or the deployment. `app/js/openrouter.js` gives OpenRouter the same
call shape as claude.ai's `sample`, so every stage works unchanged. It streams replies, strips
`<think>` blocks, reads JSON from code fences, and falls back to another free model when one is
busy. Page images go to a free model that accepts images, when one exists. The claude.ai artifact
can't use OpenRouter, because artifacts can't call outside services.

`dev/smoke-openrouter.mjs` tests this path against a fake OpenRouter. Run `smoke.mjs` first; it
creates the test PDF.

## Publishing updates

The artifact is published from `app/paper-quest.html`, with `app/js/*.js` as supporting files at
`js/*.js`, and declares the capabilities `sample`, `db`, `assets` and `user`. To ship a change,
republish the same page with the changed JS files to the same artifact URL. Your saved library
survives republishes.
