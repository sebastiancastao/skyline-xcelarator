// Fill the DHL "Indirect Air Carrier Security Certification" (IAC) form.
//
// Unlike the Air Waybill, the IAC PDF is a flat scanned image with NO AcroForm
// fields, so we can't just set field values — we overlay text at fixed
// positions on top of the scan. The positions below were measured once, via
// OCR word boxes, from the blank DHL IAC form (a 612x792pt / US-Letter page,
// rendered at 3x).
//
//   - Text fields are written just to the right of the label's colon. Fields the
//     ticket can't supply get "N/A" (the form forbids blank spaces: "use 'none'
//     or 'N/A' to indicate omitted information").
//   - Yes/No questions are answered by stamping an "X" over the chosen option.
//
// pdf-lib is server-only; it's listed in `serverExternalPackages`.

import type { DocumentMapping } from "./documents";
import { identifySouthwestFlightData } from "./southwest-flight-data";

export type IacWorkflowCarrier = "southwest" | "delta";

// Scale the OCR image was measured at (renderPageAsImage scale), and the page
// height in points. Used to map image pixels -> PDF points (origin bottom-left).
const OCR_SCALE = 3;
const PAGE_HEIGHT_PT = 792;
// A label line's text baseline sits ~30px below the line's top edge at 3x.
const BASELINE_OFFSET_PX = 30;
// Gap (pt) between the label's colon and the value we write after it.
const VALUE_GAP_PT = 8;
// The ID Verification Check rows are a table: values belong in the right-hand
// answer box rather than immediately after each printed label.
const ID_VERIFICATION_VALUE_X_PX = 1248;

type TextFieldPosition = {
  topPx: number;
  xpx: number;
  placement: "after-label" | "right-box";
};

// Text fields, keyed by printed label. Most values are written after the
// label's colon; the ID verification table instead uses a fixed box anchor.
const FIELD_POSITIONS: Record<string, TextFieldPosition> = {
  // ID Verification Check section.
  "Type of ID reviewed": {
    xpx: ID_VERIFICATION_VALUE_X_PX,
    placement: "right-box",
    topPx: 1027,
  },
  "Second type of ID reviewed": {
    xpx: ID_VERIFICATION_VALUE_X_PX,
    placement: "right-box",
    topPx: 1152,
  },
  "Printed name of individual cargo accepted from": {
    xpx: ID_VERIFICATION_VALUE_X_PX,
    placement: "right-box",
    topPx: 1242,
  },
  "Shipper's Company Name": {
    xpx: ID_VERIFICATION_VALUE_X_PX,
    placement: "right-box",
    topPx: 1288,
  },
  "Name of IAC employee who verified ID": {
    xpx: ID_VERIFICATION_VALUE_X_PX,
    placement: "right-box",
    topPx: 1355,
  },
  // DHL Same Day driver / representative section.
  "Authorized Representative / Driver's Name": {
    xpx: 795,
    placement: "after-label",
    topPx: 1479,
  },
  "Employer / Company Name": {
    xpx: 477,
    placement: "after-label",
    topPx: 1540,
  },
  // Tendering Information section.
  "Master Air Waybill": { xpx: 386, placement: "after-label", topPx: 1734 },
  "DHL Same Day Job #": { xpx: 418, placement: "after-label", topPx: 1790 },
  "Airline Tendered": { xpx: 351, placement: "after-label", topPx: 1844 },
  "Flight Number": { xpx: 320, placement: "after-label", topPx: 1898 },
  "Date Tendered": { xpx: 320, placement: "after-label", topPx: 1954 },
};

// Fields that stay blank rather than receiving the "N/A" placeholder when the
// ticket can't supply them. "Date Tendered" is completed at tender time; the
// "Master Air Waybill" is left blank when the order carries no AWB number (the
// client asked not to print "N/A" in the tendering AWB field).
const BLANK_TEXT_FIELDS = new Set(["Date Tendered", "Master Air Waybill"]);

// Yes/No questions, keyed by label. Each option is the right edge of its printed
// word and the line's vertical centre; the X is stamped just after the word.
type Point = { rightXpx: number; ypx: number };
const YES_NO_MARKS: Record<string, { Yes: Point; No: Point }> = {
  "Items under 16 oz": {
    Yes: { rightXpx: 1267, ypx: 287 },
    No: { rightXpx: 1395, ypx: 287 },
  },
  "Matching photo on ID (first)": {
    Yes: { rightXpx: 1368, ypx: 1090 },
    No: { rightXpx: 1558, ypx: 1090 },
  },
  "Matching photo on ID (second)": {
    Yes: { rightXpx: 1368, ypx: 1208 },
    No: { rightXpx: 1558, ypx: 1208 },
  },
  "Evidence of TSA Certification": {
    Yes: { rightXpx: 1252, ypx: 1621 },
    No: { rightXpx: 1459, ypx: 1621 },
  },
};

// Example IACs for this workflow use the same full authorized-representative
// name in both signature-identification roles, per carrier.
const AUTHORIZED_REPRESENTATIVE_NAMES: Record<IacWorkflowCarrier, string> = {
  southwest: "Donald Hill",
  delta: "Torine Lindsey",
};
const CARGO_ACCEPTED_FROM_NAME = "Kamel Falak";
const IAC_AIRLINE_NAMES: Record<IacWorkflowCarrier, string> = {
  southwest: "Southwest Airlines",
  delta: "Delta Air Lines",
};

const px = (v: number) => v / OCR_SCALE;

// Normalize the Master Air Waybill value for the tendering section. The parsed
// AWB can be a single number, several routing-leg AWBs joined with " / ", or a
// placeholder ("N/A"/"NA"/"none"/blank). Drop the placeholders, dedupe repeated
// AWBs, and rejoin with " / "; an empty result keeps the field blank (never
// "N/A"). Splitting on " / " (whitespace-padded) avoids breaking "N/A" apart.
function normalizeAwb(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  const tokens = String(value)
    .split(/\s+\/\s+/)
    .map((t) => t.trim())
    .filter((t) => {
      const low = t.toLowerCase();
      return t !== "" && low !== "n/a" && low !== "na" && low !== "none";
    });
  return [...new Set(tokens)].join(" / ");
}

/**
 * Map a DHL SameDay dispatch-ticket mapping onto every IAC field, or null if the
 * document isn't a ticket. Text fields the ticket can't supply are set to "N/A";
 * Yes/No questions get a "Yes"/"No" answer that's stamped as an X.
 */
export function ticketToIacValues(
  mapping: DocumentMapping,
  carrier: IacWorkflowCarrier = "southwest",
): Record<string, string> | null {
  if (mapping.type !== "dhl-sameday-ticket") return null;

  const field = (label: string) =>
    mapping.fields.find((f) => f.label === label)?.value ?? null;
  const southwestFlights =
    carrier === "southwest" ? identifySouthwestFlightData(mapping) : null;

  const out: Record<string, string> = {};
  const set = (name: string, value: string | null) => {
    if (value) out[name] = value;
  };

  // Text fields we can derive from the ticket.
  // ID Verification Check: the ID reviewed at pickup is a government-issued photo
  // ID (driver's license / state ID), so the "Type of ID reviewed" blank reads
  // "Government".
  set("Type of ID reviewed", "Government");
  set("Printed name of individual cargo accepted from", CARGO_ACCEPTED_FROM_NAME);
  set("Shipper's Company Name", field("Customer"));
  set("Employer / Company Name", field("Vendor"));
  // Real AWB(s) are rendered (deduped); a missing/"N/A" value leaves it blank.
  set("Master Air Waybill", normalizeAwb(field("Air Waybill Number")));
  set("DHL Same Day Job #", field("Ticket Number"));
  set("Airline Tendered", IAC_AIRLINE_NAMES[carrier]);
  set(
    "Flight Number",
    southwestFlights?.summary.flightNumbersCompact ?? field("Flight Number"),
  );

  // Known DHL Same Day personnel.
  const representativeName = AUTHORIZED_REPRESENTATIVE_NAMES[carrier];
  set("Authorized Representative / Driver's Name", representativeName);
  set("Name of IAC employee who verified ID", representativeName);

  // Remaining text fields are completed by the driver at pickup; use "N/A"
  // except for fields that must stay blank until tender time.
  for (const label of Object.keys(FIELD_POSITIONS)) {
    if (!out[label] && !BLANK_TEXT_FIELDS.has(label)) out[label] = "N/A";
  }

  // Yes/No answers. "Any items under 16 oz (453.6 g)?" is a property of the
  // shipment: weights are quoted in pounds, so anything ≥ 1 lb means No. The ID
  // and TSA-certification checks are affirmative for a properly tendered load.
  const weight = parseFloat(field("Gross Weight (lb)") ?? "");
  out["Items under 16 oz"] =
    Number.isFinite(weight) && weight >= 1 ? "No" : "Yes";
  out["Matching photo on ID (first)"] = "Yes";
  out["Matching photo on ID (second)"] = "Yes";
  out["Evidence of TSA Certification"] = "Yes";

  return out;
}

/**
 * Overlay the given values onto the scanned IAC form and return the saved PDF
 * bytes. Text fields are written after their label; Yes/No answers are stamped
 * as an X over the chosen option.
 */
export async function fillIacForm(
  pdfBytes: Uint8Array,
  values: Record<string, string>,
): Promise<{ bytes: Uint8Array; filled: string[]; skipped: string[] }> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const doc = await PDFDocument.load(pdfBytes);
  const page = doc.getPage(0);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0, 0, 0.6);

  // Stamp a bold "X" just to the right of an option word (image pixels).
  const markX = ({ rightXpx, ypx }: Point) => {
    const size = 13;
    page.drawText("X", {
      x: px(rightXpx) + 4,
      y: PAGE_HEIGHT_PT - px(ypx) - size * 0.35,
      size,
      font: boldFont,
      color: ink,
    });
  };

  const filled: string[] = [];
  const skipped: string[] = [];

  for (const [label, value] of Object.entries(values)) {
    const yn = YES_NO_MARKS[label];
    if (yn) {
      markX(value === "No" ? yn.No : yn.Yes);
      filled.push(label);
      continue;
    }

    const pos = FIELD_POSITIONS[label];
    if (!pos) {
      skipped.push(label);
      continue;
    }
    page.drawText(value, {
      x: px(pos.xpx) + (pos.placement === "after-label" ? VALUE_GAP_PT : 0),
      y: PAGE_HEIGHT_PT - px(pos.topPx + BASELINE_OFFSET_PX),
      size: 11,
      font,
      color: ink,
    });
    filled.push(label);
  }

  const bytes = await doc.save();
  return { bytes, filled, skipped };
}
