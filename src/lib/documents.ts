// Document classification + field mapping.
//
// Given the text of a PDF (extracted directly, or via OCR for scanned files)
// and its file name, we try to recognise *which* known document it is and pull
// a set of structured fields out of it. This is intentionally pure and
// dependency-free so it can run anywhere and be unit-tested in isolation.

export type MappedField = {
  /** Human-readable field name, e.g. "IAC Number". */
  label: string;
  /** Extracted value, or null when the field is present but blank. */
  value: string | null;
};

export type DocumentMapping = {
  /** Machine id of the matched type, e.g. "dhl-iac". */
  type: string;
  /** Human label, e.g. "DHL Indirect Air Carrier Security Certification". */
  label: string;
  /** Rough confidence in the match, 0–1. */
  confidence: number;
  /** Structured fields pulled from the document. */
  fields: MappedField[];
};

// Positional layout, used by templates whose meaning depends on *columns* (e.g.
// a two-column "PICKUP | DELIVER TO" block that the flattened text merges onto a
// single line). A cell is one positioned text fragment; a row is the fragments
// sharing a visual line, left-to-right; a page is its rows, top-to-bottom. The
// producer (the parse route) fills this from the PDF's text positions; OCR'd
// scans have no layout and pass it through as undefined.
export type LayoutCell = { x: number; text: string };
export type LayoutRow = LayoutCell[];
export type PageLayout = LayoutRow[];

type MatchContext = {
  text: string;
  fileName: string;
  /** Positional layout, one entry per page, when available. */
  layout?: PageLayout[];
};

type DocumentDefinition = {
  type: string;
  label: string;
  /** Returns 0–1 confidence that this context is the given document type. */
  match: (ctx: MatchContext) => number;
  /** Extracts the structured fields once a type has matched. */
  extract: (ctx: MatchContext) => MappedField[];
};

// --- Text helpers -----------------------------------------------------------

// Collapse all runs of whitespace to single spaces. Useful for matching across
// line breaks introduced by the PDF layout or OCR.
function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// Escape a literal string for use inside a RegExp.
function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Normalise a value: trim, drop dotted/underscore form-blank fillers, and
// return null when nothing meaningful is left. OCR of a blank form field often
// leaves stray punctuation ("|", "]", "’"), so anything without a letter or
// digit is treated as blank.
function cleanValue(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const v = raw
    .replace(/[._…]+/g, " ") // dotted / underscore blanks
    .replace(/\s+/g, " ")
    .replace(/[\s,;:|]+$/, "") // trailing separators / OCR specks
    .trim();
  if (!/[A-Za-z0-9]/.test(v)) return null;
  return v.length > 0 ? v : null;
}

// Pull the description that sits between a field label and the next field label
// in a single-line "Field: description Field: description …" document.
function descBetween(
  flat: string,
  start: string,
  end: string,
): string | null {
  const sm = flat.match(new RegExp(esc(start), "i"));
  if (!sm || sm.index === undefined) return null;
  let rest = flat.slice(sm.index + sm[0].length);
  const em = rest.match(new RegExp(esc(end), "i"));
  if (em && em.index !== undefined) rest = rest.slice(0, em.index);
  // Drop the remainder of the label (any parenthetical) up to its colon.
  rest = rest.replace(/^[^:]*:/, "");
  return cleanValue(rest);
}

// Pull the text that follows a label on the same line. Works on the original
// (line-broken) text so a blank form field yields null rather than swallowing
// the next line. `label` is a regex source matched case-insensitively.
function valueAfter(text: string, label: string): string | null {
  const re = new RegExp(`${label}[^\\S\\r\\n]*:?[^\\S\\r\\n]*([^\\r\\n]*)`, "i");
  const m = text.match(re);
  return m ? cleanValue(m[1]) : null;
}

// Pull the text between two printed labels from the whitespace-flattened text.
// This preserves wrapped values on scanned forms, such as multi-flight entries
// on the IAC tendering section.
function valueBetweenLabels(
  text: string,
  startLabel: string,
  endLabel: string | RegExp,
): string | null {
  const flat = flatten(text);
  const endSource =
    typeof endLabel === "string" ? esc(endLabel) : endLabel.source;
  const re = new RegExp(
    `${esc(startLabel)}[^:]*:\\s*(.+?)(?=\\s+(?:${endSource}))`,
    "i",
  );
  const m = flat.match(re);
  return m ? cleanValue(m[1]) : null;
}

// First capture group of a pattern over the whitespace-flattened text.
function capture(text: string, re: RegExp): string | null {
  const m = flatten(text).match(re);
  return m ? cleanValue(m[1]) : null;
}

// A Yes/No checkbox field. When the box is unmarked, OCR just reads back the
// "Yes No" options — which isn't an answer, so treat it as blank.
function checkbox(text: string, label: string): string | null {
  const v = valueAfter(text, label);
  if (!v) return null;
  return /^yes\s*[\/_]?\s*no$/i.test(v.replace(/[.,;:|]/g, "").trim())
    ? null
    : v;
}

const AIRLINE_NAMES: Record<string, string> = {
  AA: "American Airlines",
  AS: "Alaska Airlines",
  B6: "JetBlue Airways",
  DL: "Delta Air Lines",
  F9: "Frontier Airlines",
  NK: "Spirit Airlines",
  UA: "United Airlines",
  WN: "Southwest Airlines",
};

function airlineName(code: string | null): string | null {
  if (!code) return null;
  return AIRLINE_NAMES[code.toUpperCase()] ?? code;
}

function normalizeVendorName(value: string | null): string | null {
  if (!value) return null;
  if (/skyline courier/i.test(value)) return "Skyline Courier & Logistics";
  return value;
}

// --- Column layout helpers --------------------------------------------------
//
// Some forms are laid out as side-by-side columns (e.g. shipper on the left,
// consignee on the right). The flattened text glues each row's columns together
// with a single space, which makes "9851 COMMERCE WAY 1600 M H JACKSON SERVICE"
// impossible to split back into a left and a right address by text alone. The
// positional layout keeps each fragment's x, so we recover the columns by
// reading the header row's labels and assigning every data cell to the label at
// or to its left.

// The whole row's text, left-to-right, for locating a header by its labels.
function rowText(row: LayoutRow): string {
  return row.map((c) => c.text).join(" ");
}

// The header label a cell belongs to: the right-most header cell whose x is at
// or to the left of the cell (a small tolerance absorbs sub-pixel drift).
function columnLabel(header: LayoutRow, x: number): string {
  let label = "";
  for (const h of header) {
    if (h.x <= x + 8) label = h.text;
    else break;
  }
  return label;
}

// The page that holds a given template, found by a row that matches `headerRe`.
function findPage(
  layout: PageLayout[] | undefined,
  headerRe: RegExp,
): PageLayout | null {
  if (!layout) return null;
  return layout.find((page) => page.some((r) => headerRe.test(rowText(r)))) ?? null;
}

// Split the single data row beneath a header into { label: value } by column.
function rowColumns(
  page: PageLayout,
  headerRe: RegExp,
): Record<string, string> {
  const hi = page.findIndex((r) => headerRe.test(rowText(r)));
  if (hi < 0 || hi + 1 >= page.length) return {};
  const header = [...page[hi]].sort((a, b) => a.x - b.x);
  const parts: Record<string, string[]> = {};
  for (const cell of page[hi + 1]) {
    (parts[columnLabel(header, cell.x)] ??= []).push(cell.text);
  }
  return Object.fromEntries(
    Object.entries(parts).map(([k, v]) => [k, v.join(" ")]),
  );
}

// Collect the multi-row block beneath a header into { label: [line, …] } by
// column, stopping before the first row that matches `stopRe`.
function columnBlock(
  page: PageLayout,
  headerRe: RegExp,
  stopRe: RegExp,
): Record<string, string[]> {
  const hi = page.findIndex((r) => headerRe.test(rowText(r)));
  const out: Record<string, string[]> = {};
  if (hi < 0) return out;
  const header = [...page[hi]].sort((a, b) => a.x - b.x);
  for (let i = hi + 1; i < page.length; i++) {
    const row = page[i];
    if (stopRe.test(rowText(row))) break;
    const perCol: Record<string, string[]> = {};
    for (const cell of row) {
      (perCol[columnLabel(header, cell.x)] ??= []).push(cell.text);
    }
    for (const [label, cells] of Object.entries(perCol)) {
      (out[label] ??= []).push(cells.join(" "));
    }
  }
  return out;
}

// --- Known documents --------------------------------------------------------

const DHL_IAC: DocumentDefinition = {
  type: "dhl-iac",
  label: "DHL Indirect Air Carrier Security Certification",
  match: ({ text, fileName }) => {
    const flat = flatten(text).toLowerCase();
    const name = fileName.toLowerCase();
    let score = 0;
    if (/indirect air carrier security certification/.test(flat)) score += 0.6;
    if (/d\/?b\/?a\s+dhl same day/.test(flat)) score += 0.25;
    if (/\biac\s*ne\d+/.test(flat) || /assigned by tsa is\s*ne\d+/.test(flat))
      score += 0.2;
    if (/dhl/.test(name) && /iac/.test(name)) score += 0.2;
    return Math.min(score, 1);
  },
  extract: ({ text }) => {
    const masterAirWaybill =
      valueBetweenLabels(text, "Master Air Waybill", "DHL Same Day Job #") ??
      valueAfter(text, "Master Air Waybill");
    const dhlJob =
      valueBetweenLabels(text, "DHL Same Day Job #", "Airline Tendered") ??
      valueAfter(text, "DHL Same Day Job #");
    const airlineTendered =
      valueBetweenLabels(text, "Airline Tendered", "Flight Number") ??
      valueAfter(text, "Airline Tendered");
    const flightNumber =
      valueBetweenLabels(text, "Flight Number", "Date Tendered") ??
      valueAfter(text, "Flight Number");
    const dateTendered =
      valueBetweenLabels(text, "Date Tendered", /CHANGE\s*\d+|$/) ??
      valueAfter(text, "Date Tendered");

    return [
    {
      label: "IAC Number",
      value:
        capture(text, /assigned by tsa is\s*([A-Z]{2}\d+)/i) ??
        capture(text, /\bIAC\s*([A-Z]{2}\d+)/i),
    },
    {
      label: "Carrier",
      // OCR mangles the punctuation ("Inc ,"), so normalise to the canonical
      // name whenever the carrier is present.
      value: capture(text, /(Sky Courier Inc[\s.,]*d\/?b\/?a\s*DHL Same Day)/i)
        ? "Sky Courier Inc., d/b/a DHL Same Day"
        : null,
    },
    {
      label: "Revision",
      value: capture(text, /(CHANGE\s*\d+\s*[–\-]\s*[A-Za-z]+\s*\d{4})/i),
    },
    {
      label: "Items under 16 oz (453.6 g)",
      value: checkbox(text, "453\\.6\\s*grams\\)\\?"),
    },
    {
      label: "Authorized Representative / Driver's Name",
      value: valueAfter(text, "Driver'?s Name \\(printed\\)"),
    },
    { label: "Employer / Company Name", value: valueAfter(text, "Employer/?Company Name") },
    {
      label: "Evidence of TSA Certification",
      value: checkbox(text, "SIDA Badge, etc\\.\\):"),
    },
    { label: "Master Air Waybill", value: masterAirWaybill },
    { label: "DHL Same Day Job #", value: dhlJob },
    { label: "Airline Tendered", value: airlineTendered },
    { label: "Flight Number", value: flightNumber },
    { label: "Date Tendered", value: dateTendered },
  ];
  },
};

const AWB_GUIDE: DocumentDefinition = {
  type: "awb-guide",
  label: "Air Waybill Completion Guide",
  match: ({ text, fileName }) => {
    const flat = flatten(text).toLowerCase();
    const name = fileName.toLowerCase();
    let score = 0;
    if (/guide to completing a paper air waybill/.test(flat)) score += 0.7;
    if (/master air waybill|shipper'?s account number/.test(flat)) score += 0.2;
    if (/airwaybill|air waybill|awb/.test(name)) score += 0.2;
    return Math.min(score, 1);
  },
  // The guide is one long "Field name: description Field name: description …"
  // run. Pull each field's description as the text up to the next field's label.
  extract: ({ text }) => {
    const flat = flatten(text);
    // Ordered as they appear; the trailing entry is only a boundary sentinel.
    const fields = [
      "Shippers account number",
      "Shipper’s Name and Address",
      "Consignee’s Name and Address",
      "Airport of Departure",
      "Airport of Destination",
      "Declared Value for Carriage",
      "Accounting Information",
      "Handling Information",
      "No. of Pieces RCP",
      "Gross Weight",
      "Nature and Quantity of Goods",
      "Signature of Shipper", // boundary only
    ];
    return fields.slice(0, -1).map((label, i) => ({
      label: label.replace(/’/g, "'"),
      value: descBetween(flat, label, fields[i + 1]),
    }));
  },
};

// Convert a "YY/MM/DD" routing date (e.g. "26/06/08") to ISO "20YY-MM-DD".
function isoFromYYMMDD(raw: string | null): string | null {
  if (!raw) return null;
  const m = raw.match(/(\d{2})\/(\d{2})\/(\d{2})/);
  return m ? `20${m[1]}-${m[2]}-${m[3]}` : raw;
}

// Build a multi-line "Name / street / city / Attn" address from the lines that
// follow an "Address" label on the dispatch ticket, appending the phone. Unlike
// cleanValue this preserves line breaks (AWB address boxes are multi-line) and
// strips a trailing e-mail that OCR/extraction leaves on the Attn line.
function composeAddress(block: string | undefined, phone?: string): string | null {
  if (!block) return null;
  const lines = block
    .split("\n")
    .map((l) => l.replace(/\s+[\w.+-]+@[\w.-]+\b.*$/, "").trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  return phone ? `${lines.join("\n")}\nTel: ${phone}` : lines.join("\n");
}

type RoutingLeg = {
  dep: string | null;
  carrier: string | null;
  flight: string | null;
  date: string | null;
  des: string | null;
  awb: string | null;
};

// Parse the routing table's flight legs. A single-leg ticket prints one row
// ("ATL DL 0987 26/06/08 07:10 09:45 BOS F"), but a connecting itinerary prints
// the table *column by column*, so every leg's departures stack together, then
// every carrier, then every flight number, and so on — the per-row regex below
// would miss all of them. Tokenising the routing block and bucketing each token
// by its shape recovers the legs for both layouts: the i-th departure, carrier,
// flight number and date make up leg i. Airports fill two columns (Dep then
// Des), so the first leg-count codes are departures and the last are
// destinations; AWB numbers (6+ digits) sit in their own column when present.
function parseRoutingLegs(text: string): RoutingLeg[] {
  const block =
    text.match(/Retr\w+\s+Msg([\s\S]*?)(?:Delivery Date|Notice:|$)/i)?.[1] ?? "";

  const airports: string[] = [];
  const carriers: string[] = [];
  const flights: string[] = [];
  const dates: string[] = [];
  const awbs: string[] = [];
  for (const token of block.split(/\s+/)) {
    if (/^\d{2}\/\d{2}\/\d{2}$/.test(token)) dates.push(token);
    else if (/^\d{6,}$/.test(token)) awbs.push(token);
    else if (/^[A-Z]{3}$/.test(token)) airports.push(token);
    else if (/^(?=[A-Z0-9]*[A-Z])[A-Z0-9]{2}$/.test(token)) carriers.push(token);
    else if (/^\d{2,4}$/.test(token)) flights.push(token);
  }

  const legCount = Math.max(
    dates.length,
    carriers.length,
    flights.length,
    Math.floor(airports.length / 2),
  );
  if (legCount === 0) return [];

  const deps = airports.slice(0, legCount);
  const dests = airports.slice(Math.max(airports.length - legCount, legCount));
  return Array.from({ length: legCount }, (_, i) => ({
    dep: deps[i] ?? null,
    carrier: carriers[i] ?? null,
    flight: flights[i] ?? null,
    date: dates[i] ?? null,
    des: dests[i] ?? null,
    awb: awbs[i] ?? null,
  }));
}

// A DHL SameDay / Sky Courier dispatch & routing ticket. Unlike the IAC
// certification this carries the full shipment (shipper, consignee, routing,
// AWB number), so it maps directly onto the Air Waybill form.
const DHL_SAMEDAY_TICKET: DocumentDefinition = {
  type: "dhl-sameday-ticket",
  label: "DHL SameDay Dispatch Ticket",
  match: ({ text }) => {
    const flat = flatten(text).toLowerCase();
    let score = 0;
    if (/dhl\s*sameday\/sky courier/.test(flat)) score += 0.5;
    if (/ticket#\s*\d+/.test(flat)) score += 0.2;
    if (/air waybill#:\s*\d+/.test(flat)) score += 0.2;
    if (/routing info/.test(flat)) score += 0.1;
    return Math.min(score, 1);
  },
  extract: ({ text }) => {
    // Pickup/delivery address blocks: the lines after each "Address" label up to
    // the next blank line, with their phones (in document order).
    const blocks = [...text.matchAll(/Address\s+([\s\S]*?)(?=\n[ \t]*\n)/g)].map(
      (m) => m[1],
    );
    const phones = [
      ...text.matchAll(/Phone\s*(\(\d{3}\)\s*\d{3}-?\d{4})/g),
    ].map((m) => m[1]);

    // Routing legs: a connecting itinerary lists more than one (e.g. ATL→DEN
    // then DEN→SNA), so capture them all — the first leg's origin is the
    // departure and the last leg's destination is the final airport.
    const legs = parseRoutingLegs(text);
    const firstLeg = legs[0] ?? null;
    const lastLeg = legs[legs.length - 1] ?? null;

    // A connecting itinerary tenders each leg on its own flight, so the IAC's
    // Flight Number / Date Tendered list every leg's value separated by " / ".
    const joinLegs = (fn: (l: (typeof legs)[number]) => string | null) =>
      legs.length ? legs.map(fn).join(" / ") : null;

    // Air waybill(s): connecting legs each print their own AWB# in the routing
    // table; a direct flight instead prints a single master AWB at the foot.
    const legAwbs = legs.map((l) => l.awb).filter((v): v is string => Boolean(v));
    const footerAwbs = [...text.matchAll(/AIR WAYBILL#:\s*(\d+)/gi)].map(
      (m) => m[1],
    );
    const airWaybills = legAwbs.length ? legAwbs : footerAwbs;

    // Totals row: "Total <pcs> <wgt> <len> <wid> <hgt>".
    const totals = text.match(
      /Total\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/,
    );

    // Issuing agent city/state from the header banner.
    const agentCity = capture(
      text,
      /Sky Courier\s*-\s*[^-]*-\s*([A-Za-z .]+,\s*[A-Z]{2})/i,
    );

    return [
      {
        label: "Air Waybill Number",
        value: airWaybills.length ? airWaybills.join(" / ") : null,
      },
      { label: "Ticket Number", value: capture(text, /Ticket#\s*(\d+)/i) },
      { label: "Customer", value: valueAfter(text, "Cust Name") },
      { label: "Reference Number", value: capture(text, /Reference#\s*(\d+)/i) },
      { label: "Description", value: valueAfter(text, "Description") },
      { label: "Pieces", value: totals ? totals[1] : null },
      { label: "Gross Weight (lb)", value: totals ? totals[2] : null },
      {
        label: "Dimensions (in)",
        value: totals ? `${totals[3]} x ${totals[4]} x ${totals[5]}` : null,
      },
      {
        label: "Shipper Name and Address",
        value: composeAddress(blocks[0], phones[0]),
      },
      {
        label: "Consignee Name and Address",
        value: composeAddress(blocks[1], phones[1]),
      },
      { label: "Origin Airport", value: firstLeg?.dep ?? null },
      { label: "Destination Airport", value: lastLeg?.des ?? null },
      { label: "Carrier", value: firstLeg?.carrier ?? null },
      { label: "Airline Tendered", value: airlineName(firstLeg?.carrier ?? null) },
      { label: "Flight Number", value: joinLegs((l) => l.flight) },
      { label: "Flight Date", value: joinLegs((l) => isoFromYYMMDD(l.date)) },
      {
        // Full requested routing, leg by leg, for the AWB's multi-leg boxes:
        // "DEP-DES CARRIER FLIGHT" per leg. A direct flight has a single leg.
        label: "Routing",
        value: legs.length
          ? legs
              .map((l) => `${l.dep}-${l.des} ${l.carrier} ${l.flight}`)
              .join(" · ")
          : null,
      },
      {
        label: "Issuing Agent",
        value: agentCity ? `DHL SameDay / Sky Courier, ${agentCity}` : null,
      },
      { label: "Part Number", value: capture(text, /\b(\d{4}-\d{4}-\d{4})\b/) },
      {
        // The subcontracted courier ("Vendor: 57126 SKYLINE COURIER LOGT") —
        // the driver's employer for the IAC certification.
        label: "Vendor",
        value: normalizeVendorName(
          cleanValue(text.match(/Vendor:\s*\d*\s*([^\n]+)/i)?.[1] ?? null),
        ),
      },
    ];
  },
};

// Compose an AIT address column (the lines of one column of the PICKUP /
// DELIVER TO block) into a multi-line block that parseAddressBlock can read:
// name / street(s) / "City ST ZIP", with the "Contact:" line turned into a
// "Tel:" line and the redundant domestic country line dropped.
function composeAitAddress(lines: string[] | undefined): string | null {
  if (!lines) return null;
  let phone: string | null = null;
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const contact = line.match(/^contact:?\s*(.*)$/i);
    if (contact) {
      if (contact[1].trim()) phone = contact[1].trim();
      continue;
    }
    if (/^(united states|usa)$/i.test(line)) continue; // drop domestic country
    out.push(line);
  }
  if (phone) out.push(`Tel: ${phone}`);
  return out.length ? out.join("\n") : null;
}

// An AIT Worldwide Logistics "Pickup Order" dispatch ticket. It carries the full
// shipment (pickup, deliver-to, routing, cargo, references), so it maps directly
// onto an Axis order. The PDF sometimes arrives behind an "Email Cover Sheet"
// page and sometimes on its own — extraction keys off the page that holds the
// ticket, not its page number.
const AIT_PICKUP_ORDER: DocumentDefinition = {
  type: "ait-pickup-order",
  label: "AIT Worldwide Logistics Pickup Order",
  match: ({ text, fileName }) => {
    const flat = flatten(text).toLowerCase();
    const name = fileName.toLowerCase();
    let score = 0;
    if (/pickup order/.test(flat)) score += 0.4;
    if (/ait worldwide logistics/.test(flat)) score += 0.3;
    if (/\bshipment\s+s\d+/.test(flat)) score += 0.2;
    if (/\bconsol\s+c\d+/.test(flat)) score += 0.1;
    if (/reference ait'?s shipment number/.test(flat)) score += 0.2;
    if (/pickup order/.test(name)) score += 0.2;
    return Math.min(score, 1);
  },
  extract: ({ text, layout }) => {
    const flat = flatten(text);
    const page = findPage(layout, /\bPICKUP\b.*\bDELIVER TO\b/);

    // Two-column blocks (need positional layout to split the columns).
    const addr = page
      ? columnBlock(page, /\bPICKUP\b.*\bDELIVER TO\b/, /\bReady\b/)
      : {};
    const parties = page ? rowColumns(page, /\bSHIPPER\b\s+CONSIGNEE\b/) : {};
    const route = page
      ? rowColumns(page, /\bORIGIN\b.*\bDESTINATION\b/)
      : {};
    const goods = page
      ? rowColumns(page, /\bGOODS DESCRIPTION\b.*\bMAWB\b/)
      : {};
    const flight = page
      ? rowColumns(page, /\bMode\b.*\bCarrier\b.*\bLoad\b/)
      : {};

    // Cargo line ("3 CTN 75.000 LB 10.125 CF 18 18 18 IN").
    const pkg = flat.match(
      /PACKAGES\s+TYPE\b[\s\S]*?\b(\d+)\s+([A-Z]+)\s+([\d.]+)\s*LB\s+([\d.]+)\s*CF\s+(\d+)\s+(\d+)\s+(\d+)\s*IN/i,
    );

    const origin = route["ORIGIN"] ?? null;
    const destination = route["DESTINATION"] ?? null;

    return [
      { label: "Shipment Number", value: capture(text, /\bSHIPMENT\s+(S\d+)/i) },
      { label: "Consol Number", value: capture(text, /\bCONSOL\s+(C\d+)/i) },
      {
        label: "Order Date",
        value: capture(text, /\bDATE\s+(\d{1,2}-[A-Za-z]{3}-\d{2}\s+\d{2}:\d{2})/),
      },
      { label: "Shipper", value: cleanValue(parties["SHIPPER"]) },
      { label: "Consignee", value: cleanValue(parties["CONSIGNEE"]) },
      { label: "Origin", value: cleanValue(origin) },
      { label: "ETD", value: cleanValue(route["ETD"]) },
      { label: "Destination", value: cleanValue(destination) },
      { label: "ETA", value: cleanValue(route["ETA"]) },
      { label: "Pickup Name and Address", value: composeAitAddress(addr["PICKUP"]) },
      {
        label: "Deliver To Name and Address",
        value: composeAitAddress(addr["DELIVER TO"]),
      },
      {
        label: "Ready",
        value: capture(text, /\bReady\s+(\d{1,2}-[A-Za-z]{3}-\d{2}\s+\d{2}:\d{2})/i),
      },
      {
        label: "Close",
        value: capture(text, /\bClose\s+(\d{1,2}-[A-Za-z]{3}-\d{2}\s+\d{2}:\d{2})/i),
      },
      { label: "Mode", value: cleanValue(flight["Mode"]) },
      { label: "Carrier", value: cleanValue(flight["Carrier"]) },
      { label: "Flight / Date", value: cleanValue(flight["Flight / Date"]) },
      { label: "Flight ETD", value: cleanValue(flight["ETD"]) },
      { label: "Flight ETA", value: cleanValue(flight["ETA"]) },
      {
        label: "Order Ref",
        value: capture(text, /SHIPPERS REFERENCE\s+Order Ref\s+([A-Za-z0-9][A-Za-z0-9-]*)/i),
      },
      {
        label: "Goods Description",
        value: cleanValue(goods["GOODS DESCRIPTION"]),
      },
      { label: "MAWB", value: cleanValue(goods["MAWB"]) },
      { label: "HAWB", value: cleanValue(goods["HAWB"]) },
      { label: "Pieces", value: pkg ? pkg[1] : null },
      { label: "Package Type", value: pkg ? pkg[2] : null },
      { label: "Gross Weight (lb)", value: pkg ? pkg[3] : null },
      { label: "Volume", value: pkg ? `${pkg[4]} CF` : null },
      {
        label: "Dimensions (in)",
        value: pkg ? `${pkg[5]} x ${pkg[6]} x ${pkg[7]}` : null,
      },
    ];
  },
};

// --- ICAT Logistics "Routing Alert" -----------------------------------------
//
// A dispatch ticket ICAT Logistics sends to its local courier (Skyline). It
// carries the full local job — where to pick up, the cargo, the airline the
// shipment is tendered to, and the ultimate consignee — laid out as a dense
// two-column form. The flattened text interleaves the columns, so extraction
// works off the positional layout (the page that holds "ROUTING ALERT").

// Index of the first row on the page that contains a cell matching `re`.
function icatRowIndex(page: PageLayout, re: RegExp): number {
  return page.findIndex((row) => row.some((c) => re.test(c.text)));
}

// The cell immediately to the right of the first cell whose text matches
// `labelRe`, scanned across every row; null when the label or its value is
// absent. An optional minimum x restricts the value to a given column.
function icatValueAfter(
  page: PageLayout,
  labelRe: RegExp,
  minX = -Infinity,
): string | null {
  for (const row of page) {
    const i = row.findIndex((c) => labelRe.test(c.text));
    if (i < 0) continue;
    const next = row[i + 1];
    if (next && next.x >= minX) return cleanValue(next.text);
    return null;
  }
  return null;
}

// The cell to the right of `labelRe` as a money value, with the dots preserved
// (cleanValue strips them as form-blank fillers). Null unless the cell holds a
// number, so a stray wrapped label on the same row isn't mistaken for a value.
function icatMoneyAfter(
  page: PageLayout,
  labelRe: RegExp,
  minX = -Infinity,
): string | null {
  for (const row of page) {
    const i = row.findIndex((c) => labelRe.test(c.text));
    if (i < 0) continue;
    const next = row[i + 1];
    if (!next || next.x < minX || !/\d/.test(next.text)) return null;
    return next.text.replace(/[^\d.,]/g, "").replace(/[.,]$/, "") || null;
  }
  return null;
}

// The text of cells whose x is in [minX, maxX) across rows [from, to), top to
// bottom and left to right — used to read one column of a two-column block.
function icatColumnLines(
  page: PageLayout,
  from: number,
  to: number,
  minX: number,
  maxX: number,
): string[] {
  const lines: string[] = [];
  for (let i = from; i < to && i < page.length; i++) {
    for (const c of page[i]) {
      if (c.x >= minX && c.x < maxX) lines.push(c.text);
    }
  }
  return lines;
}

// Compose an address column into the multi-line block parseAddressBlock reads:
// name / street(s) / "City ST ZIP", with contact and phone as Attn:/Tel: lines.
function composeIcatAddress(
  lines: string[],
  contact: string | null,
  phone: string | null,
): string | null {
  const out = lines.map((l) => l.trim()).filter(Boolean);
  if (contact) out.push(`Attn: ${contact}`);
  if (phone) out.push(`Tel: ${phone}`);
  return out.length ? out.join("\n") : null;
}

const ICAT_ROUTING_ALERT: DocumentDefinition = {
  type: "icat-routing-alert",
  label: "ICAT Logistics Routing Alert",
  match: ({ text, fileName }) => {
    const flat = flatten(text).toLowerCase();
    const name = fileName.toLowerCase();
    let score = 0;
    if (/routing alert/.test(flat)) score += 0.5;
    if (/icat logistics/.test(flat)) score += 0.3;
    if (/must drop at linehaul\/airline by/.test(flat)) score += 0.2;
    if (/\bhawb\b/.test(flat) && /\bmawb\b/.test(flat)) score += 0.1;
    if (/routing\s*alert/.test(name) && /icat/.test(name)) score += 0.2;
    return Math.min(score, 1);
  },
  extract: ({ layout }) => {
    const page = findPage(layout, /ROUTING ALERT/i);
    const blank = (labels: string[]): MappedField[] =>
      labels.map((label) => ({ label, value: null }));
    const labels = [
      "HAWB Number", "MAWB Number", "Shipper Reference", "Service Level",
      "Service Code", "Pickup Name and Address", "Consignee Name and Address",
      "Shipper Name and Address", "Ultimate Destination", "Linehaul/Airline",
      "Carrier", "Flight Number", "Origin Airport", "Destination Airport",
      "ETD", "ETA", "Must Drop By", "A/L Service Level", "A/L Account #",
      "Shipment Date", "Ready", "Close", "Pieces", "Package Type",
      "Gross Weight (lb)", "Dimensions (in)", "Description", "Declared Value",
      "Pick-up Charges Expected", "Requested By", "ICAT Location",
      "Shipper Known", "Instructions",
    ];
    if (!page) return blank(labels);

    // Section anchors. Row order is stable but indices shift between tickets
    // (optional instruction lines, wrapped foreign addresses), so read relative
    // to these rather than hard-coding row numbers.
    const pickIdx = icatRowIndex(page, /^Pick-up at:/);
    const shipDateIdx = icatRowIndex(page, /^Shipment Date/);
    // The cargo header spans several cells, so match the whole row's text.
    const cargoHdrIdx = page.findIndex((r) =>
      /Pieces.*WEIGHT.*DIMENSIONS/.test(rowText(r)),
    );
    const consigneeIdx = icatRowIndex(page, /^Consignee:/);
    const linehaulIdx = icatRowIndex(page, /^Linehaul\/Airline:/);

    // Pick-up block: the left column (x 70–335) between "Pick-up at:" and
    // "Shipment Date:"; contact name sits to the right on the "Pick-up at:" row,
    // and the contact phone is the right-column value on a "Phone # :" row.
    const pickEnd = shipDateIdx > pickIdx ? shipDateIdx : page.length;
    const pickupLines =
      pickIdx >= 0 ? icatColumnLines(page, pickIdx, pickEnd, 70, 335) : [];
    const pickupContact =
      pickIdx >= 0
        ? cleanValue(page[pickIdx].find((c) => c.x >= 440)?.text ?? null)
        : null;
    let pickupPhone: string | null = null;
    for (let i = pickIdx; i >= 0 && i < pickEnd; i++) {
      const row = page[i];
      const j = row.findIndex((c) => c.x >= 335 && /^Phone\s*#/.test(c.text));
      if (j >= 0 && row[j + 1]) {
        pickupPhone = cleanValue(row[j + 1].text);
        break;
      }
    }

    // Consignee block (MAWB ROUTING): the right column (x ≥ 340) from the
    // "Consignee:" row down to "Linehaul/Airline:", with the "Phone:" value
    // pulled out as a Tel: line rather than a stray street line.
    const consEnd = linehaulIdx > consigneeIdx ? linehaulIdx : page.length;
    const consigneeLines: string[] = [];
    let consigneePhone: string | null = null;
    for (let i = consigneeIdx; i >= 0 && i < consEnd; i++) {
      const row = page[i];
      const phoneIdx = row.findIndex((c) => /^Phone:/i.test(c.text));
      row.forEach((c, k) => {
        if (c.x < 340) return;
        if (phoneIdx >= 0 && k === phoneIdx + 1) {
          consigneePhone = cleanValue(c.text);
          return;
        }
        consigneeLines.push(c.text);
      });
    }

    // Shipper block (MAWB ROUTING): the left column (x 70–309) over the same
    // rows. Display-only — the actual pickup is the "Pick-up at:" block above.
    const shipperLines =
      consigneeIdx >= 0
        ? icatColumnLines(page, consigneeIdx, consEnd, 70, 309)
        : [];

    // Cargo line beneath the "Pieces WEIGHT DIMENSIONS DESCRIPTION" header:
    // "<pieces> <type> <weight> <L> x <W> x <H> <description>".
    const cargoRow =
      cargoHdrIdx >= 0 && page[cargoHdrIdx + 1]
        ? page[cargoHdrIdx + 1].map((c) => c.text).join(" ")
        : "";
    const cargo = cargoRow.match(
      /^\s*(\d+)\s+([A-Za-z]+)\s+([\d.]+)\s+(\d+)\s*x\s*(\d+)\s*x\s*(\d+)\s*(.*)$/i,
    );

    // Flight routing: the data row beneath the "Carrier: Flight #: …" header,
    // split into columns. Keys are trimmed so trailing spaces don't break them.
    const routeRaw = rowColumns(
      page,
      /Carrier:.*Flight #:.*Origin:.*Dest:.*ETD:.*ETA:/,
    );
    const route: Record<string, string> = {};
    for (const [k, v] of Object.entries(routeRaw)) route[k.trim()] = v;

    // Service level row: short code (e.g. "NF") then descriptive ("Next Flight
    // Out"); keep both.
    const slRow = page.find((r) => r.some((c) => /^Service Level:/.test(c.text)));
    let serviceCode: string | null = null;
    let serviceLevel: string | null = null;
    if (slRow) {
      const i = slRow.findIndex((c) => /^Service Level:/.test(c.text));
      const after = slRow.slice(i + 1);
      serviceCode = cleanValue(after[0]?.text ?? null);
      serviceLevel = cleanValue(
        (after.length > 1 ? after.slice(1) : after).map((c) => c.text).join(" "),
      );
    }

    // "Ready: 1:30 PM To 4:00 PM" arrives as a single cell; strip the label.
    const readyCell = page
      .flatMap((r) => r)
      .find((c) => /^Ready:/.test(c.text));
    const ready = readyCell
      ? cleanValue(readyCell.text.replace(/^Ready:\s*/, ""))
      : null;

    // Instructions: the left-column lines between "Instructions:" and the
    // standing "Please contact local ICAT office" footer.
    const instrIdx = icatRowIndex(page, /^Instructions:/);
    const footerIdx = icatRowIndex(page, /Please contact local ICAT/);
    const instructions =
      instrIdx >= 0
        ? cleanValue(
            icatColumnLines(
              page,
              instrIdx + 1,
              footerIdx > instrIdx ? footerIdx : page.length,
              -Infinity,
              335,
            ).join(" "),
          )
        : null;

    const shipperKnown =
      page.flatMap((r) => r).find((c) => /\(Shipper is( not)? known\)/i.test(c.text))
        ?.text ?? null;

    return [
      { label: "HAWB Number", value: icatValueAfter(page, /^HAWB # :/, 440) },
      { label: "MAWB Number", value: icatValueAfter(page, /^MAWB#:/) },
      {
        label: "Shipper Reference",
        value: icatValueAfter(page, /^Shipper Reference/, 440),
      },
      { label: "Service Level", value: serviceLevel },
      { label: "Service Code", value: serviceCode },
      {
        label: "Pickup Name and Address",
        value: composeIcatAddress(pickupLines, pickupContact, pickupPhone),
      },
      {
        label: "Consignee Name and Address",
        value: composeIcatAddress(consigneeLines, null, consigneePhone),
      },
      {
        label: "Shipper Name and Address",
        value: composeIcatAddress(shipperLines, null, null),
      },
      {
        label: "Ultimate Destination",
        value: icatValueAfter(page, /^Ultimate Dest:/, 440),
      },
      {
        label: "Linehaul/Airline",
        value: icatValueAfter(page, /^Linehaul\/Airline:/),
      },
      { label: "Carrier", value: cleanValue(route["Carrier:"] ?? null) },
      { label: "Flight Number", value: cleanValue(route["Flight #:"] ?? null) },
      { label: "Origin Airport", value: cleanValue(route["Origin:"] ?? null) },
      { label: "Destination Airport", value: cleanValue(route["Dest:"] ?? null) },
      { label: "ETD", value: cleanValue(route["ETD:"] ?? null) },
      { label: "ETA", value: cleanValue(route["ETA:"] ?? null) },
      {
        label: "Must Drop By",
        value: icatValueAfter(page, /^Must drop at linehaul\/airline by:/),
      },
      {
        label: "A/L Service Level",
        value: icatValueAfter(page, /^A\/L Svc Level:/, 440),
      },
      { label: "A/L Account #", value: icatValueAfter(page, /^A\/L Acct #:/) },
      {
        label: "Shipment Date",
        value: icatValueAfter(page, /^Shipment Date:/),
      },
      { label: "Ready", value: ready },
      { label: "Close", value: icatValueAfter(page, /^Close:/, 440) },
      { label: "Pieces", value: cargo ? cargo[1] : null },
      { label: "Package Type", value: cargo ? cargo[2] : null },
      { label: "Gross Weight (lb)", value: cargo ? cargo[3] : null },
      {
        label: "Dimensions (in)",
        value: cargo ? `${cargo[4]} x ${cargo[5]} x ${cargo[6]}` : null,
      },
      {
        label: "Description",
        value: cargo ? cargo[7].replace(/\s+/g, " ").trim() || null : null,
      },
      {
        label: "Declared Value",
        value: icatMoneyAfter(page, /^Declared Value \$:/, 440),
      },
      {
        label: "Pick-up Charges Expected",
        value: icatMoneyAfter(page, /^Pick-up Charges Expected/),
      },
      { label: "Requested By", value: icatValueAfter(page, /^Requested\b/, 60) },
      { label: "ICAT Location", value: icatValueAfter(page, /^Location:/) },
      { label: "Shipper Known", value: cleanValue(shipperKnown) },
      { label: "Instructions", value: instructions },
    ];
  },
};

const DEFINITIONS: DocumentDefinition[] = [
  DHL_IAC,
  AWB_GUIDE,
  DHL_SAMEDAY_TICKET,
  AIT_PICKUP_ORDER,
  ICAT_ROUTING_ALERT,
];

const MIN_CONFIDENCE = 0.5;

/**
 * Identify the document type and map its fields. Returns null when nothing
 * matches confidently enough.
 */
export function classifyAndMap(
  text: string,
  fileName: string,
  layout?: PageLayout[],
): DocumentMapping | null {
  const ctx: MatchContext = { text, fileName, layout };

  let best: { def: DocumentDefinition; score: number } | null = null;
  for (const def of DEFINITIONS) {
    const score = def.match(ctx);
    if (!best || score > best.score) best = { def, score };
  }

  if (!best || best.score < MIN_CONFIDENCE) return null;

  return {
    type: best.def.type,
    label: best.def.label,
    confidence: Math.round(best.score * 100) / 100,
    fields: best.def.extract(ctx),
  };
}
