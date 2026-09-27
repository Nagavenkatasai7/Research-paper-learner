/* Paper Quest — PDF handling with pdf.js: open, pull readable text (two-column aware),
 * find the paper's sections, and render pages to canvas or JPEG. */
"use strict";
(function (PQ) {
  const PDFJS_VERSION = "3.11.174";

  function lib() {
    const pdfjs = window.pdfjsLib;
    if (!pdfjs) throw new Error("The PDF reader didn't load. Check your connection and reload the page.");
    if (!pdfjs.GlobalWorkerOptions.workerSrc) {
      // pdf.worker.min.js is also loaded as a page script, so pdf.js runs its worker code on the
      // main thread and never has to start a cross-origin Worker.
      pdfjs.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.js`;
    }
    return pdfjs;
  }

  /** Open a PDF from a Blob or ArrayBuffer. */
  async function open(data) {
    const buf = data instanceof Blob ? await data.arrayBuffer() : data;
    const task = lib().getDocument({ data: new Uint8Array(buf.slice(0)), isEvalSupported: false });
    return task.promise;
  }

  async function metaTitle(doc) {
    try {
      const m = await doc.getMetadata();
      const t = (m && m.info && m.info.Title) || "";
      return /^(untitled|microsoft word|arxiv|\s*$)/i.test(t) || t.length < 8 ? "" : t.trim();
    } catch (e) {
      return "";
    }
  }

  /* ---------------- Text extraction ---------------- */

  /** Group positioned text items into lines, reading two-column pages column by column. */
  function pageLines(items, pageWidth) {
    const pieces = items
      .filter((it) => it.str && it.str.trim())
      .map((it) => ({
        s: it.str,
        x: it.transform[4],
        y: it.transform[5],
        w: it.width || 0,
        h: Math.abs(it.transform[3]) || it.height || 10,
      }));
    if (!pieces.length) return [];

    const mid = pageWidth / 2;
    const rowsOf = (list) => {
      const sorted = [...list].sort((a, b) => b.y - a.y || a.x - b.x);
      const rows = [];
      for (const p of sorted) {
        const row = rows[rows.length - 1];
        if (row && Math.abs(row.y - p.y) <= Math.max(2, Math.min(row.h, p.h) * 0.45)) {
          row.items.push(p);
          row.h = Math.max(row.h, p.h);
        } else rows.push({ y: p.y, h: p.h, items: [p] });
      }
      return rows;
    };

    // Two-column test: in a two-column layout almost no line crosses the middle gutter.
    const all = rowsOf(pieces);
    const crossing = all.filter((r) => r.items.some((p) => p.x < mid - 4 && p.x + p.w > mid + 4)).length;
    const twoCol = all.length > 8 && crossing / all.length < 0.3;

    const rows = twoCol
      ? [...rowsOf(pieces.filter((p) => p.x < mid - 4 || p.x + p.w / 2 < mid)), ...rowsOf(pieces.filter((p) => !(p.x < mid - 4 || p.x + p.w / 2 < mid)))]
      : all;

    return rows.map((r) => {
      r.items.sort((a, b) => a.x - b.x);
      let text = "";
      let end = null;
      for (const p of r.items) {
        if (end !== null && p.x - end > p.h * 0.15 && !/\s$/.test(text) && !/^\s/.test(p.s)) text += " ";
        text += p.s;
        end = p.x + p.w;
      }
      return { text: text.replace(/\s+/g, " ").trim(), h: r.h };
    });
  }

  const NAMED =
    /^(?:(?:\d{1,2}|[IVX]{1,4})\.?\s+)?(abstract|introduction|related work|related works|background|preliminaries|problem (?:setup|formulation|statement)|method|methods|methodology|approach|our approach|model|model architecture|architecture|experiments?|experimental setup|experimental results|evaluation|results|analysis|discussion|conclusions?|conclusion and future work|limitations|future work|references|bibliography|appendix|appendices|acknowledge?ments)\s*$/i;
  const NUMBERED = /^(\d{1,2})\.?\s+([A-Z][^.!?;]{1,72})$/;
  const REFS = /^(?:\d{1,2}\.?\s+)?(references|bibliography)\s*$/i;
  const OPTIONAL = /references|bibliography|acknowledge?ments|appendix|appendices/i;

  /**
   * Extract readable text and structure.
   * Returns {pages:[{n,text}], fullText, sections:[{id,title,page,start,end,optional}], mainText, numPages}
   */
  async function extract(doc, onProgress) {
    const pages = [];
    const allLines = [];
    for (let n = 1; n <= doc.numPages; n++) {
      if (onProgress) onProgress(n, doc.numPages);
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const lines = pageLines(content.items, vp.width);
      lines.forEach((l) => allLines.push({ ...l, page: n }));
      pages.push({ n, lines });
      page.cleanup();
    }

    // Typical body-text height, to spot bigger heading lines.
    const heights = allLines.map((l) => l.h).sort((a, b) => a - b);
    const body = heights.length ? heights[Math.floor(heights.length / 2)] : 10;

    let fullText = "";
    const headings = [];
    let lastNum = 0;
    let refsSeen = false;
    for (const p of pages) {
      fullText += `\n[[p.${p.n}]]\n`;
      for (const line of p.lines) {
        const t = line.text;
        if (t.length > 2 && t.length < 90) {
          const named = NAMED.test(t);
          const num = t.match(NUMBERED);
          let isHeading = false;
          if (named) isHeading = true;
          else if (num && !refsSeen) {
            const n = Number(num[1]);
            const words = num[2].trim().split(/\s+/).length;
            if (n === lastNum + 1 && words <= 9 && line.h >= body * 0.98) isHeading = true;
          }
          if (isHeading) {
            if (num) lastNum = Number(num[1]);
            if (REFS.test(t)) refsSeen = true;
            headings.push({ title: t.replace(/\s+/g, " "), page: p.n, start: fullText.length });
          }
        }
        fullText += t + "\n";
      }
    }
    // Join words hyphenated across line breaks.
    const dehyphen = (s) => s.replace(/(\w)-\n(\w)/g, "$1$2");

    // Drop duplicate headings (a table of contents or running header repeating one).
    const seen = new Set();
    const uniq = headings.filter((h) => {
      const key = h.title.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    let sections = [];
    if (uniq.length >= 2) {
      if (uniq[0].start > 400) uniq.unshift({ title: "Title & abstract", page: 1, start: 0 });
      sections = uniq.map((h, i) => ({
        title: h.title,
        page: h.page,
        start: h.start,
        end: i + 1 < uniq.length ? uniq[i + 1].start : fullText.length,
      }));
    } else {
      // No headings found: fall back to two-page chunks.
      for (let n = 1; n <= pages.length; n += 2) {
        const a = fullText.indexOf(`[[p.${n}]]`);
        const bIdx = fullText.indexOf(`[[p.${n + 2}]]`);
        sections.push({ title: n + 1 <= pages.length ? `Pages ${n}–${n + 1}` : `Page ${n}`, page: n, start: a, end: bIdx < 0 ? fullText.length : bIdx });
      }
    }
    sections = sections.map((s, i) => ({ ...s, id: `s${i}`, optional: OPTIONAL.test(s.title) }));

    const refs = sections.find((s) => REFS.test(s.title));
    const mainText = dehyphen(refs ? fullText.slice(0, refs.start) : fullText);

    return {
      numPages: doc.numPages,
      pages: pages.map((p) => ({ n: p.n, text: dehyphen(p.lines.map((l) => l.text).join("\n")) })),
      fullText,
      sections,
      mainText,
      sectionText(sec) {
        return dehyphen(fullText.slice(sec.start, sec.end));
      },
    };
  }

  /* ---------------- Rendering ---------------- */
  async function renderPage(doc, n, canvas, cssWidth) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vp = page.getViewport({ scale: (cssWidth / base.width) * dpr });
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
    return { width: base.width, height: base.height };
  }

  /** A JPEG of one page, sized for Claude to read (about 1.2 MP after the platform downsizes). */
  async function pageImage(doc, n) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const scale = 1400 / base.width;
    const vp = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", 0.86));
  }

  PQ.pdf = { open, extract, metaTitle, renderPage, pageImage };
})(window.PQ);
