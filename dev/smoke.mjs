// End-to-end smoke test for Paper Quest against a mocked claude.ai runtime.
// Usage: cd dev && npm install && node smoke.mjs [outDir]
// It builds a small fake paper PDF, uploads it, and plays through all six quest stops.
import { chromium } from "playwright";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, "..", "app");
const outDir = process.argv[2] || path.join(here, "screenshots");
await mkdir(outDir, { recursive: true });

const CDN = {
  "pdf.js/3.11.174/pdf.min.js": "node_modules/pdfjs-dist/build/pdf.min.js",
  "pdf.js/3.11.174/pdf.worker.min.js": "node_modules/pdfjs-dist/build/pdf.worker.min.js",
  "mathjax/3.2.2/es5/tex-svg-full.js": "node_modules/mathjax/es5/tex-svg-full.js",
};

// The published page is wrapped in a skeleton by the platform; do the same here.
const pageBody = await readFile(path.join(appDir, "paper-quest.html"), "utf8");
const harness = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>:root{color-scheme:light}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>
<script src="/mock-claude.js"></script></head><body>${pageBody}</body></html>`;

const browser = await chromium.launch();
const errors = [];

async function makePaperPdf() {
  const p = await browser.newPage();
  const para = (t) => `<p>${t} `.repeat(1) + "Attention mechanisms let a model weigh how relevant every token is to every other token, which makes long-range dependencies easy to learn and lets training run in parallel on modern hardware.".repeat(3) + "</p>";
  await p.setContent(`<html><body style="font-family:Times;font-size:12pt;margin:60px">
    <h1 style="font-size:22pt;text-align:center">Attention Is a Test Paper</h1>
    <p style="text-align:center">Ada Lovelace, Alan Turing, Grace Hopper</p>
    <h2 style="font-size:14pt">Abstract</h2>${para("We propose a new architecture.")}
    <h2 style="font-size:14pt">1 Introduction</h2>${para("Recurrent models read one word at a time.")}${para("This is slow.")}
    <h2 style="font-size:14pt">2 Method</h2>${para("We compute queries, keys and values.")}
    <p>Attention(Q, K, V) = softmax(QK^T / sqrt(d_k)) V (1)</p>${para("Multiple heads run in parallel.")}${para("Positions are encoded with sines.")}
    <h2 style="font-size:14pt">3 Experiments</h2>${para("We train on WMT 2014 English-German.")}${para("We reach 28.4 BLEU.")}
    <h2 style="font-size:14pt">4 Conclusion</h2>${para("Attention is enough.")}
    <h2 style="font-size:14pt">References</h2><p>[1] Somebody. A paper. 2016.</p>
  </body></html>`);
  const pdf = await p.pdf({ format: "Letter" });
  await p.close();
  return pdf;
}

const pdfBytes = await makePaperPdf();
const pdfPath = path.join(outDir, "test-paper.pdf");
await writeFile(pdfPath, pdfBytes);

const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
});
await page.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  if (url.host === "pq.test") {
    if (url.pathname === "/" || url.pathname === "/index.html") return route.fulfill({ body: harness, contentType: "text/html" });
    if (url.pathname === "/mock-claude.js") return route.fulfill({ path: path.join(here, "mock-claude.js"), contentType: "text/javascript" });
    return route.fulfill({ path: path.join(appDir, url.pathname), contentType: url.pathname.endsWith(".js") ? "text/javascript" : undefined });
  }
  if (url.host === "cdnjs.cloudflare.com") {
    const key = Object.keys(CDN).find((k) => url.pathname.endsWith(k));
    if (key) return route.fulfill({ path: path.join(here, CDN[key]), contentType: "text/javascript" });
  }
  return route.abort(); // fonts and anything else: offline in tests
});

const shot = (name) => page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: false });
const step = async (name, fn) => {
  process.stdout.write(`• ${name} … `);
  await fn();
  console.log("ok");
};

try {
  await page.goto("https://pq.test/");
  await step("library renders", async () => {
    await page.getByRole("heading", { name: /Paper\s*Quest/ }).waitFor();
    await page.getByText("Start a new quest").waitFor();
    await shot("01-library-empty");
  });

  await step("upload PDF and build the brain", async () => {
    await page.setInputFiles("#pdf-input", pdfPath);
    await page.getByText("Ready for the story?").waitFor({ timeout: 20000 });
    await shot("02-story-intro");
  });

  await step("story mode plays through", async () => {
    await page.getByRole("button", { name: "Make my story" }).click();
    for (let i = 0; i < 6; i++) {
      await page.locator(".board svg.drawing").waitFor();
      const svgHtml = await page.locator(".board svg.drawing").innerHTML();
      if (/script|onclick/i.test(svgHtml)) throw new Error("SVG sanitizer let a script/handler through");
      if (i === 2) {
        await page.waitForTimeout(4500);
        await shot("03-story-scene");
      }
      await page.locator(".check .opt").first().click();
      if (i < 5) await page.getByRole("button", { name: "Next scene →" }).click();
    }
    await page.getByText("Story cleared.").waitFor();
    await page.getByRole("button", { name: "Go to Map" }).click();
  });

  await step("concept map lights up", async () => {
    await page.locator(".mapbox svg .node").first().waitFor();
    await shot("04-map");
    await page.getByRole("button", { name: "Draw it for me" }).click();
    await page.locator(".panel .board svg.drawing").waitFor();
    for (let i = 0; i < 5; i++) {
      await page.locator(".node:not(.lit)").first().click();
      await page.locator(".panel .check .opt").first().click();
      await page.waitForTimeout(1600);
    }
    await page.getByText("Map cleared.").waitFor();
    await shot("05-map-lit");
    await page.getByRole("button", { name: "Go to Read" }).click();
  });

  await step("guided reading", async () => {
    await page.locator(".pagebox canvas").first().waitFor();
    await page.getByText("This section explains the recipe.").waitFor();
    await page.locator(".pagebox .ptools button").first().click();
    await page.getByText("Figure 1: boxes are layers.").waitFor();
    await page.fill("#askq", "Why divide by the square root?");
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await page.getByText("It's like turning down the volume.").waitFor();
    await page.waitForTimeout(800);
    const geo = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".pagebox")).map((b) => {
        const r = b.getBoundingClientRect();
        const c = b.querySelector("canvas").getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), canvasH: Math.round(c.height), ar: b.style.aspectRatio };
      })
    );
    for (let i = 0; i + 1 < geo.length; i++) {
      if (geo[i].bottom > geo[i + 1].top + 1 || geo[i].canvasH > geo[i].bottom - geo[i].top + 1) throw new Error(`PDF pages overlap: ${JSON.stringify(geo)}`);
    }
    await shot("06-read");
    const n = await page.locator(".sec:not(.optional)").count();
    for (let i = 0; i < n; i++) {
      const btn = page.getByRole("button", { name: "I read this section" });
      await btn.waitFor();
      await btn.click();
      await page.waitForTimeout(250);
    }
    await page.getByText("Read cleared.").waitFor();
    await page.getByRole("button", { name: "Go to X-ray" }).click();
  });

  await step("equation x-ray", async () => {
    await page.locator(".xpick").first().click();
    await page.locator(".xcard .eq-big svg").first().waitFor({ timeout: 20000 });
    await page.locator(".xcard").nth(1).waitFor();
    await page.waitForTimeout(400);
    await shot("07-xray");
    const fallback = await page.locator(".xcard").nth(1).locator(".eq-big svg, .eq-big .tex-fallback").count();
    if (!fallback) throw new Error("broken equation split did not fall back");
    await page.getByRole("button", { name: "Go to Teach" }).click();
  });

  await step("teach pip", async () => {
    await page.fill("#teach-input", "It lets every word look at every other word at once.");
    await page.getByRole("button", { name: "Explain to Pip" }).click();
    await page.getByText("Small fix: it's not a memory bank.").waitFor();
    await page.getByRole("button", { name: /hint/ }).click();
    await page.getByText(/Hint: Look at Section 3/).waitFor();
    await page.fill("#teach-input", "Scores become weights, and heads look for patterns, and it beat old models.");
    await page.getByRole("button", { name: "Explain to Pip" }).click();
    await page.fill("#teach-input", "And it trains faster.");
    await page.getByRole("button", { name: "Explain to Pip" }).click();
    await page.getByText("Teach cleared.").waitFor();
    await shot("08-teach");
    await page.getByRole("button", { name: "Go to Brainstorm" }).click();
  });

  await step("brainstorm board", async () => {
    await page.getByRole("button", { name: "Research ideas" }).click();
    await page.locator(".note").first().waitFor();
    await page.locator(".note").nth(0).getByRole("button", { name: "Select" }).click();
    await page.locator(".note").nth(1).getByRole("button", { name: "Select" }).click();
    await page.getByRole("button", { name: /Combine selected/ }).click();
    await page.getByText("Music plus translation").waitFor();
    await page.locator(".note").first().getByRole("button", { name: "Go deeper" }).click();
    await page.getByText("treating notes like words").waitFor();
    await page.locator(".note").first().getByRole("button", { name: /Keep/ }).click();
    await page.getByText(/quest complete|complete\. See you tomorrow/).first().waitFor();
    await shot("09-brainstorm");
  });

  await step("library shows the finished day and progress persists", async () => {
    await page.getByRole("button", { name: "Back to library" }).click();
    await page.getByText("Quest done").waitFor();
    await shot("10-library");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.locator(".paper-card").first().click();
    await page.locator(".stop").nth(1).click();
    await page.locator(".mapbox svg .node").first().waitFor();
    await shot("10b-map-dark");
    await page.locator(".stop").nth(0).click();
    await page.locator(".board svg.drawing").waitFor();
    await page.waitForTimeout(3000);
    await shot("10c-story-dark");
    await page.emulateMedia({ colorScheme: "light" });
    const stored = await page.evaluate(() => Array.from(window.__mockDocs.keys()));
    if (!stored.some((k) => k.startsWith("data/users/u_test/p_"))) throw new Error("paper not saved under the viewer's private path");
    const calls = await page.evaluate(() => window.__mockCalls);
    const big = calls.filter((c) => c.bytes > 65536);
    if (big.length) throw new Error(`prompt over 64 KiB: ${JSON.stringify(big)}`);
    console.log(`\n  ${calls.length} Claude calls: ${[...new Set(calls.map((c) => c.task))].join(", ")}`);
  });

  await step("reopen the paper from the library (fresh load)", async () => {
    await page.reload();
    await page.getByRole("heading", { name: /Paper\s*Quest/ }).waitFor();
    // Memory store is reset on reload, so this checks the page boots cleanly with nothing saved.
    await page.getByText("Start a new quest").waitFor();
  });

  await step("phone width layout has no sideways scroll", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 1) throw new Error(`page scrolls sideways by ${overflow}px`);
    await shot("11-phone");
  });
} catch (e) {
  console.log("FAILED");
  console.error(e);
  await shot("zz-failure").catch(() => {});
  process.exitCode = 1;
}

const relevant = errors.filter((e) => !/Failed to load resource|ERR_FAILED|net::/i.test(e));
if (relevant.length) {
  console.log("\nBrowser errors:");
  relevant.forEach((e) => console.log("  " + e));
  process.exitCode = 1;
}
await browser.close();
