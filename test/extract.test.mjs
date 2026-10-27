import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { extractText } from "../dist/extract.js";
import { htmlToText } from "../dist/text.js";

test("htmlToText keeps structure and links", () => {
  const text = htmlToText('<p>Read <a href="https://x.dk/a">chapter 3</a></p><ul><li>One</li><li>Two &amp; three</li></ul><p>Bye&nbsp;now</p>');
  assert.equal(text, "Read chapter 3 (https://x.dk/a)\n\n- One\n- Two & three\n\nBye now");
});

test("extracts text from a .docx", async () => {
  const zip = new JSZip();
  zip.file("word/document.xml", '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Exercise 1</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Prove </w:t></w:r><w:r><w:t>it.</w:t></w:r></w:p></w:body></w:document>');
  const out = await extractText(await zip.generateAsync({ type: "nodebuffer" }), "ex.docx");
  assert.equal(out.text, "Exercise 1\nProve it.");
});

test("extracts cells from a notebook", async () => {
  const nb = { cells: [{ cell_type: "markdown", source: ["# Week 5"] }, { cell_type: "code", source: "print(1)" }] };
  const out = await extractText(Buffer.from(JSON.stringify(nb)), "w5.ipynb");
  assert.match(out.text, /--- Cell 1 \(markdown\) ---\n# Week 5/);
  assert.match(out.text, /--- Cell 2 \(code\) ---\nprint\(1\)/);
});

test("returns null for unknown binary formats", async () => {
  assert.equal(await extractText(Buffer.from([0, 1, 2]), "video.mp4", "video/mp4"), null);
});
