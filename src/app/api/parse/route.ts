import { NextRequest, NextResponse } from "next/server";
import { getDocumentProxy, getMeta } from "unpdf";
import { simpleParser, type Attachment, type ParsedMail } from "mailparser";
import {
  classifyAndMap,
  type DocumentMapping,
  type LayoutRow,
  type PageLayout,
} from "@/lib/documents";
import { ocrPdf, TEXT_THRESHOLD } from "@/lib/ocr";

// PDF and EML parsing rely on Node APIs, so force the Node.js runtime.
export const runtime = "nodejs";

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB per file
const MAX_FILES = 500;
const CONCURRENCY = 5; // parse this many files at once to cap memory use

// Run an async mapper over items with a bounded number of concurrent workers,
// preserving input order in the results.
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

type FileResult =
  | {
      ok: true;
      fileName: string;
      fileSize: number;
      totalPages: number;
      text: string;
      info: Record<string, unknown>;
      // True when the text was recovered via OCR (scanned/image-only PDF).
      ocrUsed: boolean;
      // Detected document type + mapped fields, or null if unrecognised.
      mapping: DocumentMapping | null;
    }
  | {
      ok: false;
      fileName: string;
      fileSize: number;
      error: string;
    };

// A pdf.js text fragment. pdf.js returns text in positioned chunks with no
// guaranteed spaces between them, so we reconstruct spacing ourselves.
type TextItem = {
  str: string;
  hasEOL: boolean;
  width: number;
  height: number;
  transform: number[]; // [a, b, c, d, e(x), f(y)]
};

function endsWithSpace(s: string) {
  return s.length === 0 || /\s$/.test(s);
}

// Rebuild readable text from positioned fragments: insert a space when there is
// a horizontal gap between fragments, and a newline on end-of-line markers or a
// vertical jump.
function reconstructPageText(items: TextItem[]): string {
  let out = "";
  let prev: TextItem | null = null;

  for (const item of items) {
    const str = item.str ?? "";

    if (prev) {
      const prevX = prev.transform[4];
      const prevY = prev.transform[5];
      const x = item.transform[4];
      const y = item.transform[5];

      const lineHeight = item.height || prev.height || 10;
      const verticalJump = Math.abs(y - prevY);

      if (verticalJump > lineHeight * 0.5) {
        // New visual line.
        out = out.replace(/[ \t]+$/, "") + "\n";
      } else {
        const prevEndX = prevX + prev.width;
        const gap = x - prevEndX;
        // A gap wider than ~a quarter em means the fragments were separated by
        // whitespace in the original document.
        const spaceWidth = lineHeight * 0.25;
        if (gap > spaceWidth && !endsWithSpace(out) && !/^\s/.test(str)) {
          out += " ";
        }
      }
    }

    out += str;

    if (item.hasEOL) {
      out = out.replace(/[ \t]+$/, "") + "\n";
      prev = null;
      continue;
    }
    prev = item;
  }

  return out;
}

function tidy(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, "")) // trim trailing whitespace
    .join("\n")
    .replace(/\n{3,}/g, "\n\n") // collapse runs of blank lines
    .trim();
}

// Group positioned fragments into rows by their baseline y (top-to-bottom),
// each row's cells ordered left-to-right. This preserves the page's column
// structure, which the flattened text discards — templates whose meaning lives
// in side-by-side columns (e.g. a "PICKUP | DELIVER TO" block) use it to split
// the columns back apart. A new row starts when the vertical gap exceeds half a
// line height, mirroring reconstructPageText's line-break rule.
function reconstructPageCells(items: TextItem[]): LayoutRow[] {
  const used = items.filter((i) => (i.str ?? "").trim() !== "");
  used.sort(
    (a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4],
  );

  const rows: LayoutRow[] = [];
  let row: LayoutRow = [];
  let rowY: number | null = null;
  for (const item of used) {
    const y = item.transform[5];
    const tol = Math.max((item.height || 10) * 0.5, 3);
    if (rowY !== null && rowY - y > tol) {
      rows.push(row.sort((a, b) => a.x - b.x));
      row = [];
      rowY = null;
    }
    if (rowY === null) rowY = y;
    row.push({ x: item.transform[4], text: item.str });
  }
  if (row.length) rows.push(row.sort((a, b) => a.x - b.x));
  return rows;
}

async function extractFormattedText(
  pdf: Awaited<ReturnType<typeof getDocumentProxy>>,
): Promise<{ totalPages: number; text: string; layout: PageLayout[] }> {
  const totalPages = pdf.numPages;
  const pages: string[] = [];
  const layout: PageLayout[] = [];

  for (let n = 1; n <= totalPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    // pdf.js items are TextItem | TextMarkedContent; keep only the text ones.
    const items = content.items.filter(
      (i) => typeof (i as { str?: unknown }).str === "string",
    ) as unknown as TextItem[];
    pages.push(tidy(reconstructPageText(items)));
    layout.push(reconstructPageCells(items));
  }

  // Separate pages clearly while keeping the output easy to read.
  const text = pages
    .map((p, i) => `--- Page ${i + 1} ---\n${p}`.trimEnd())
    .join("\n\n")
    .trim();

  return { totalPages, text, layout };
}

function isPdfFile(contentType: string | undefined, name: string) {
  return contentType === "application/pdf" || name.toLowerCase().endsWith(".pdf");
}

function isEmlFile(contentType: string | undefined, name: string) {
  return contentType === "message/rfc822" || name.toLowerCase().endsWith(".eml");
}

function unsupportedResult(file: File, name: string): FileResult {
  return {
    ok: false,
    fileName: name,
    fileSize: file.size,
    error: "Not a PDF or EML file.",
  };
}

function tooLargeResult(fileSize: number, name: string): FileResult {
  return {
    ok: false,
    fileName: name,
    fileSize,
    error: "File is too large (max 25 MB).",
  };
}

async function parsePdfBytes(input: {
  bytes: Uint8Array;
  name: string;
  fileSize: number;
}): Promise<FileResult> {
  const { bytes, name, fileSize } = input;
  if (fileSize > MAX_BYTES) {
    return tooLargeResult(fileSize, name);
  }

  try {
    const buffer = new Uint8Array(bytes);
    const pdf = await getDocumentProxy(buffer);
    const [extracted, meta] = await Promise.all([
      extractFormattedText(pdf),
      getMeta(pdf),
    ]);

    const { totalPages } = extracted;
    let text = extracted.text;
    // Positional layout backs column-aware extraction; OCR (below) produces a
    // plain text recovery with no positions, so it's cleared when OCR is used.
    let layout: PageLayout[] | undefined = extracted.layout;
    let ocrUsed = false;

    // No usable text layer (e.g. a scanned form) - recover it with OCR so the
    // document can still be classified and mapped.
    if (text.replace(/--- Page \d+ ---/g, "").trim().length < TEXT_THRESHOLD) {
      try {
        // pdf.js transfers (and detaches) `buffer` to its worker, so OCR needs
        // its own fresh copy of the bytes.
        const ocrBuffer = new Uint8Array(bytes);
        const ocrText = await ocrPdf(ocrBuffer, totalPages);
        if (ocrText.length > text.length) {
          text = ocrText;
          layout = undefined; // OCR text has no positional layout
          ocrUsed = true;
        }
      } catch (ocrErr) {
        console.error(`OCR failed for ${name}:`, ocrErr);
      }
    }

    return {
      ok: true,
      fileName: name,
      fileSize,
      totalPages,
      text,
      info: meta.info ?? {},
      ocrUsed,
      mapping: classifyAndMap(text, name, layout),
    };
  } catch (err) {
    console.error(`PDF parse error for ${name}:`, err);
    return {
      ok: false,
      fileName: name,
      fileSize,
      error: "Failed to parse - the PDF may be corrupted or encrypted.",
    };
  }
}

function addressText(value: ParsedMail["from"] | ParsedMail["to"]) {
  if (!value) return undefined;
  if (Array.isArray(value)) {
    const text = value.map((v) => v.text).filter(Boolean).join(", ");
    return text || undefined;
  }
  return value.text || undefined;
}

function htmlToPlainText(html: ParsedMail["html"]) {
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|tr|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ");
}

function composeEmailText(mail: ParsedMail) {
  const headers = [
    ["Subject", mail.subject],
    ["From", addressText(mail.from)],
    ["To", addressText(mail.to)],
    ["Cc", addressText(mail.cc)],
    ["Date", mail.date?.toISOString()],
  ]
    .filter(([, value]) => Boolean(value))
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n");

  const body = tidy(mail.text ?? htmlToPlainText(mail.html));
  return [headers, body].filter(Boolean).join("\n\n").trim();
}

function emailInfo(mail: ParsedMail) {
  return {
    subject: mail.subject ?? null,
    from: addressText(mail.from) ?? null,
    to: addressText(mail.to) ?? null,
    cc: addressText(mail.cc) ?? null,
    date: mail.date?.toISOString() ?? null,
    messageId: mail.messageId ?? null,
    attachmentCount: mail.attachments.length,
  };
}

function attachmentName(parentName: string, attachment: Attachment, index: number) {
  const leaf = (attachment.filename || `attachment-${index + 1}.pdf`).replace(
    /[\\/]+/g,
    "_",
  );
  return `${parentName}/${leaf}`;
}

async function parseEmlFile(file: File, name: string): Promise<FileResult[]> {
  if (file.size > MAX_BYTES) {
    return [tooLargeResult(file.size, name)];
  }

  try {
    const mail = await simpleParser(Buffer.from(await file.arrayBuffer()));
    const pdfAttachments = mail.attachments.filter((attachment) =>
      isPdfFile(attachment.contentType, attachment.filename ?? ""),
    );

    if (pdfAttachments.length > 0) {
      return Promise.all(
        pdfAttachments.map((attachment, i) =>
          parsePdfBytes({
            bytes: new Uint8Array(attachment.content),
            name: attachmentName(name, attachment, i),
            fileSize: attachment.size,
          }),
        ),
      );
    }

    const text = composeEmailText(mail);
    if (!text) {
      return [
        {
          ok: false,
          fileName: name,
          fileSize: file.size,
          error: "No email body text or PDF attachments found.",
        },
      ];
    }

    return [
      {
        ok: true,
        fileName: name,
        fileSize: file.size,
        totalPages: 1,
        text,
        info: emailInfo(mail),
        ocrUsed: false,
        mapping: classifyAndMap(text, name),
      },
    ];
  } catch (err) {
    console.error(`EML parse error for ${name}:`, err);
    return [
      {
        ok: false,
        fileName: name,
        fileSize: file.size,
        error: "Failed to parse the EML message.",
      },
    ];
  }
}

async function parseFile(input: {
  file: File;
  name: string;
}): Promise<FileResult[]> {
  const { file, name } = input;
  if (isPdfFile(file.type, name)) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return [await parsePdfBytes({ bytes, name, fileSize: file.size })];
  }

  if (isEmlFile(file.type, name)) {
    return parseEmlFile(file, name);
  }

  return [unsupportedResult(file, name)];
}

async function parseFileOld(input: {
  file: File;
  name: string;
}): Promise<FileResult> {
  const { file, name } = input;
  const isPdf =
    file.type === "application/pdf" || name.toLowerCase().endsWith(".pdf");
  if (!isPdf) {
    return { ok: false, fileName: name, fileSize: file.size, error: "Not a PDF file." };
  }
  if (file.size > MAX_BYTES) {
    return {
      ok: false,
      fileName: name,
      fileSize: file.size,
      error: "File is too large (max 25 MB).",
    };
  }

  try {
    const buffer = new Uint8Array(await file.arrayBuffer());
    const pdf = await getDocumentProxy(buffer);
    const [extracted, meta] = await Promise.all([
      extractFormattedText(pdf),
      getMeta(pdf),
    ]);

    const { totalPages } = extracted;
    let text = extracted.text;
    // Positional layout backs column-aware extraction; OCR (below) produces a
    // plain text recovery with no positions, so it's cleared when OCR is used.
    let layout: PageLayout[] | undefined = extracted.layout;
    let ocrUsed = false;

    // No usable text layer (e.g. a scanned form) — recover it with OCR so the
    // document can still be classified and mapped.
    if (text.replace(/--- Page \d+ ---/g, "").trim().length < TEXT_THRESHOLD) {
      try {
        // pdf.js transfers (and detaches) `buffer` to its worker, so OCR needs
        // its own fresh copy of the bytes.
        const ocrBuffer = new Uint8Array(await file.arrayBuffer());
        const ocrText = await ocrPdf(ocrBuffer, totalPages);
        if (ocrText.length > text.length) {
          text = ocrText;
          layout = undefined; // OCR text has no positional layout
          ocrUsed = true;
        }
      } catch (ocrErr) {
        console.error(`OCR failed for ${name}:`, ocrErr);
      }
    }

    return {
      ok: true,
      fileName: name,
      fileSize: file.size,
      totalPages,
      text,
      info: meta.info ?? {},
      ocrUsed,
      mapping: classifyAndMap(text, name, layout),
    };
  } catch (err) {
    console.error(`PDF parse error for ${name}:`, err);
    return {
      ok: false,
      fileName: name,
      fileSize: file.size,
      error: "Failed to parse — the PDF may be corrupted or encrypted.",
    };
  }
}

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const files = formData.getAll("file").filter((f): f is File => f instanceof File);
  // Parallel list of relative paths (e.g. "reports/q1/file.pdf") so files from
  // folder uploads keep a distinguishable display name. Falls back to file.name.
  const paths = formData.getAll("path").map((p) => String(p));

  if (files.length === 0) {
    return NextResponse.json({ error: "No files uploaded." }, { status: 400 });
  }
  if (files.length > MAX_FILES) {
    return NextResponse.json(
      { error: `Too many files (max ${MAX_FILES}).` },
      { status: 413 },
    );
  }

  const inputs = files.map((file, i) => ({
    file,
    name: paths[i] || file.name,
  }));
  // parseFile returns an array per input (an EML can expand into several PDF
  // attachments), so flatten to the flat FileResult[] the client expects.
  const nested = await mapLimit(inputs, CONCURRENCY, parseFile);
  const results = nested.flat();
  return NextResponse.json({ results });
}
