#!/usr/bin/env node
/**
 * Benchmark helper: macOS Vision OCR (mac-ocr) over a list of image paths.
 * Mirrors the pipeline's urlExtract ocrWithVision: `ocr(buf, { languageCorrection: false })`.
 * Prints one JSON array: [{ path, text, confidence }] — one entry per input.
 */
import { readFile } from "node:fs/promises";

const { ocr } = await import("mac-ocr");
const paths = process.argv.slice(2);
const out = [];
for (const p of paths) {
  try {
    const buf = await readFile(p);
    const result = await ocr(buf, { languageCorrection: false });
    const confs = (result.observations ?? []).map((o) => o.confidence);
    out.push({
      path: p,
      text: result.text ?? "",
      confidence: confs.length ? Math.max(...confs) : 0,
    });
  } catch (e) {
    out.push({ path: p, text: "", confidence: 0, error: String(e).slice(0, 140) });
  }
}
console.log(JSON.stringify(out));
