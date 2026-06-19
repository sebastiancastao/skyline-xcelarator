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

type MatchContext = { text: string; fileName: string };

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

const DEFINITIONS: DocumentDefinition[] = [
  DHL_IAC,
  AWB_GUIDE,
  DHL_SAMEDAY_TICKET,
];

const MIN_CONFIDENCE = 0.5;

/**
 * Identify the document type and map its fields. Returns null when nothing
 * matches confidently enough.
 */
export function classifyAndMap(
  text: string,
  fileName: string,
): DocumentMapping | null {
  const ctx: MatchContext = { text, fileName };

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
