// Smoke test for the OpenRouter brain used outside claude.ai (e.g. the Vercel site).
// OpenRouter itself is faked: /models returns a small free-model list, and /chat/completions
// streams the canned answers from mock-claude.js as server-sent events.
// Usage: cd dev && node smoke-openrouter.mjs [outDir]
import { chromium } from "playwright";
import { readFile, mkdir } from "node:fs/promises";
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
const pageBody = await readFile(path.join(appDir, "paper-quest.html"), "utf8");
// No window.claude here: this is how the page runs on Vercel.
const harness = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}[hidden]{display:none!important}</style></head><body>${pageBody}</body></html>`;

const browser = await chromium.launch();
const answers = await browser.newPage(); // loads the mock only to borrow its canned answers
await answers.setContent("<html><body></body></html>");
await answers.addScriptTag({ path: path.join(here, "mock-claude.js") });

const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await context.newPage();
const errors = [];
const requests = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));

const MODELS = {
  data: [
    { id: "meta-llama/llama-3.3-70b-instruct:free", name: "Llama 3.3 70B (free)", context_length: 131072, architecture: { input_modalities: ["text"] }, pricing: { prompt: "0", completion: "0" } },
    { id: "google/gemma-3-27b-it:free", name: "Gemma 3 27B (free)", context_length: 96000, architecture: { input_modalities: ["text", "image"] }, pricing: { prompt: "0", completion: "0" } },
    { id: "openai/gpt-4o", name: "GPT-4o (paid)", context_length: 128000, architecture: { input_modalities: ["text", "image"] }, pricing: { prompt: "0.0000025", completion: "0.00001" } },
  ],
};
const sse = (text, { fence = false, think = false } = {}) => {
  let body = think ? `<think>planning the notes</think>` : "";
  body += fence ? `Here you go:\n\`\`\`json\n${text}\n\`\`\`` : text;
  const parts = [body.slice(0, 40), body.slice(40, 200), body.slice(200)].filter(Boolean);
  return [": OPENROUTER PROCESSING", ...parts.map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}`), `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`, "data: [DONE]"].join("\n\n") + "\n\n";
};

let rateLimitOnce = true;
await page.route("**/*", async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  if (url.host === "pq.test") {
    if (url.pathname === "/") return route.fulfill({ body: harness, contentType: "text/html" });
    return route.fulfill({ path: path.join(appDir, url.pathname), contentType: url.pathname.endsWith(".js") ? "text/javascript" : undefined });
  }
  if (url.host === "cdnjs.cloudflare.com") {
    const key = Object.keys(CDN).find((k) => url.pathname.endsWith(k));
    if (key) return route.fulfill({ path: path.join(here, CDN[key]), contentType: "text/javascript" });
  }
  if (url.host === "openrouter.ai") {
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (url.pathname === "/api/v1/models") return route.fulfill({ json: MODELS, headers: cors });
    if (url.pathname === "/api/v1/chat/completions") {
      const body = JSON.parse(req.postData());
      const auth = req.headers()["authorization"] || "";
      const content = body.messages[0].content;
      const text = typeof content === "string" ? content : content.find((c) => c.type === "text").text;
      const task = (text.match(/^TASK: (\w+)/) || [])[1] || "ping";
      requests.push({ task, model: body.model, image: Array.isArray(content) && content.some((c) => c.type === "image_url") });
      if (auth !== "Bearer sk-or-v1-test-good") return route.fulfill({ status: 401, json: { error: { message: "No auth credentials found", code: 401 } }, headers: cors });
      if (task === "story_script" && rateLimitOnce) {
        rateLimitOnce = false; // first model is busy: the adapter should fall back to the next free model
        return route.fulfill({ status: 429, json: { error: { message: "Rate limit exceeded: free-models-per-min" } }, headers: cors });
      }
      const answer = await answers.evaluate((t) => window.__mockAnswer(t), task);
      return route.fulfill({ status: 200, headers: { ...cors, "content-type": "text/event-stream" }, body: sse(answer, { fence: task === "story_script", think: task === "brain" }) });
    }
  }
  return route.abort();
});

const shot = (name) => page.screenshot({ path: path.join(outDir, `${name}.png`) });
const step = async (name, fn) => {
  process.stdout.write(`• ${name} … `);
  await fn();
  console.log("ok");
};

try {
  await page.goto("https://pq.test/");
  await step("brain card shows free models only", async () => {
    await page.getByRole("heading", { name: "Give Pip a free brain" }).waitFor();
    await page.locator("#or-model option", { hasText: "Gemma 3 27B" }).waitFor({ state: "attached" });
    const opts = await page.locator("#or-model option").allTextContents();
    if (opts.some((o) => /GPT-4o/.test(o))) throw new Error("paid model offered");
    await shot("or-01-brain-card");
  });
  await step("a wrong key is refused with a clear message", async () => {
    await page.fill("#or-key", "sk-or-v1-wrong");
    await page.getByRole("button", { name: "Connect" }).click();
    await page.getByText("OpenRouter didn't accept that key").waitFor();
  });
  await step("a good key connects and the banner names the model", async () => {
    await page.fill("#or-key", "sk-or-v1-test-good");
    await page.getByRole("button", { name: "Connect" }).click();
    await page.getByText(/Pip is thinking with .* \(free, via OpenRouter\)/).waitFor();
    const saved = await page.evaluate(() => localStorage.getItem("pq:openrouter"));
    if (!saved || !saved.includes("sk-or-v1-test-good")) throw new Error("key not kept in this browser");
  });
  await step("key survives a reload", async () => {
    await page.reload();
    await page.getByText(/Pip is thinking with/).waitFor();
  });
  await step("upload → brain (with <think> stripped) → story (fenced JSON, 429 fallback)", async () => {
    await page.setInputFiles("#pdf-input", path.join(outDir, "test-paper.pdf"));
    await page.getByText("Ready for the story?").waitFor({ timeout: 20000 });
    await page.getByRole("button", { name: "Make my story" }).click();
    await page.locator(".board svg.drawing").waitFor({ timeout: 20000 });
    await page.waitForTimeout(3500);
    await shot("or-02-story");
  });
  await step("explain this page sends the page image to the vision model", async () => {
    await page.locator(".check .opt").first().click();
    for (let i = 1; i < 6; i++) {
      await page.getByRole("button", { name: "Next scene →" }).click();
      await page.locator(".check .opt").first().click();
    }
    await page.locator(".stop").nth(2).click();
    await page.getByRole("button", { name: "Skip ahead anyway" }).click();
    await page.locator(".pagebox .ptools button").first().click();
    await page.getByText("Figure 1: boxes are layers.").waitFor();
    const ex = requests.find((r) => r.task === "explain_page");
    if (!ex || !ex.image || ex.model !== "google/gemma-3-27b-it:free") throw new Error(`explain_page request: ${JSON.stringify(ex)}`);
  });
  console.log(`  requests: ${requests.map((r) => `${r.task}@${r.model.split("/")[1]}`).join(", ")}`);
} catch (e) {
  console.log("FAILED");
  console.error(e);
  await shot("or-zz-failure").catch(() => {});
  process.exitCode = 1;
}
const relevant = errors.filter((e) => !/Failed to load resource|ERR_FAILED|net::|401|429/i.test(e));
if (relevant.length) {
  console.log("\nBrowser errors:");
  relevant.forEach((e) => console.log("  " + e));
  process.exitCode = 1;
}
await browser.close();
