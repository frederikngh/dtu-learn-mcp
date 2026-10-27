/** Text extraction for the file types course material usually comes in. */
import path from "node:path";
import { decodeEntities, htmlToText } from "./text.js";

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".csv", ".tsv", ".json", ".xml", ".yaml", ".yml", ".tex", ".bib",
  ".py", ".ipynb", ".m", ".r", ".jl", ".c", ".h", ".cpp", ".hpp", ".java", ".js", ".ts", ".sql", ".sh",
]);

export interface Extracted {
  text: string;
  /** Short note on how the text was produced, e.g. "PDF, 23 pages". */
  kind: string;
}

export async function extractText(data: Buffer, filename: string, contentType = ""): Promise<Extracted | null> {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".pdf" || contentType.includes("pdf")) return extractPdf(data);
  if (ext === ".pptx") return extractPptx(data);
  if (ext === ".docx") return extractDocx(data);
  if (ext === ".html" || ext === ".htm" || contentType.includes("text/html")) {
    return { text: htmlToText(data.toString("utf8")), kind: "HTML" };
  }
  if (ext === ".ipynb") return extractNotebook(data);
  if (TEXT_EXTENSIONS.has(ext) || contentType.startsWith("text/")) {
    return { text: data.toString("utf8"), kind: "text" };
  }
  return null;
}

async function extractPdf(data: Buffer): Promise<Extracted> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(data),
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let line = "";
    const lines: string[] = [];
    for (const item of content.items as { str?: string; hasEOL?: boolean }[]) {
      if (typeof item.str !== "string") continue;
      line += item.str;
      if (item.hasEOL) {
        lines.push(line);
        line = "";
      }
    }
    if (line) lines.push(line);
    pages.push(`--- Page ${i} ---\n${lines.join("\n").trim()}`);
    page.cleanup();
  }
  await task.destroy();
  const text = pages.join("\n\n");
  const looksScanned = text.replace(/--- Page \d+ ---/g, "").trim().length < doc.numPages * 20;
  return {
    text,
    kind: `PDF, ${doc.numPages} page${doc.numPages === 1 ? "" : "s"}${looksScanned ? " (little text found: may be scanned images or mostly figures)" : ""}`,
  };
}

function xmlRuns(xml: string, runTag: string, paraTag: string): string {
  const paras = xml.split(new RegExp(`</${paraTag}>`));
  const out: string[] = [];
  const runRe = new RegExp(`<${runTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${runTag}>`, "g");
  for (const p of paras) {
    const parts: string[] = [];
    for (const m of p.matchAll(runRe)) parts.push(decodeEntities(m[1]));
    const line = parts.join("").trim();
    if (line) out.push(line);
  }
  return out.join("\n");
}

function numbered(names: string[], re: RegExp): string[] {
  return names
    .filter((n) => re.test(n))
    .sort((a, b) => Number(re.exec(a)![1]) - Number(re.exec(b)![1]));
}

async function extractPptx(data: Buffer): Promise<Extracted> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(data);
  const names = Object.keys(zip.files);
  const slides = numbered(names, /^ppt\/slides\/slide(\d+)\.xml$/);
  const out: string[] = [];
  for (const name of slides) {
    const n = /slide(\d+)\.xml$/.exec(name)![1];
    const body = xmlRuns(await zip.file(name)!.async("string"), "a:t", "a:p");
    let notes = "";
    const notesFile = zip.file(`ppt/notesSlides/notesSlide${n}.xml`);
    if (notesFile) {
      notes = xmlRuns(await notesFile.async("string"), "a:t", "a:p")
        .split("\n")
        .filter((l) => !/^\d+$/.test(l)) // drop the slide-number placeholder
        .join("\n");
    }
    out.push(`--- Slide ${n} ---\n${body}${notes ? `\n[Speaker notes]\n${notes}` : ""}`);
  }
  return { text: out.join("\n\n"), kind: `PowerPoint, ${slides.length} slides` };
}

async function extractDocx(data: Buffer): Promise<Extracted> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(data);
  const doc = zip.file("word/document.xml");
  if (!doc) return { text: "", kind: "Word document (no text found)" };
  return { text: xmlRuns(await doc.async("string"), "w:t", "w:p"), kind: "Word document" };
}

function extractNotebook(data: Buffer): Extracted {
  try {
    const nb = JSON.parse(data.toString("utf8")) as { cells?: { cell_type: string; source: string | string[] }[] };
    const cells = (nb.cells ?? []).map((c, i) => {
      const src = Array.isArray(c.source) ? c.source.join("") : c.source;
      return `--- Cell ${i + 1} (${c.cell_type}) ---\n${src}`;
    });
    return { text: cells.join("\n\n"), kind: `Jupyter notebook, ${cells.length} cells` };
  } catch {
    return { text: data.toString("utf8"), kind: "notebook (unparsed)" };
  }
}
