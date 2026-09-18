// Fill the Air Waybill (AWB) AcroForm on page 3 of the airway-bill PDF using
// data mapped from another document (currently the DHL IAC certification).
//
// pdf-lib is server-only; it's listed in `serverExternalPackages`.

import type { DocumentMapping } from "./documents";
import { identifySouthwestFlightData } from "./southwest-flight-data";

const SOUTHWEST_ACCOUNT_NO = "30021-015";

// Reserved key carried in the values map (not an AcroForm field): text drawn as
// a positioned overlay just below the shipper's account-number box.
const SHIPPER_REF_OVERLAY_KEY = "__shipperRefOverlay";
const FLIGHT_BOX_OVERLAY_LEFT_KEY = "__flightBoxOverlayLeft";
const FLIGHT_BOX_OVERLAY_RIGHT_KEY = "__flightBoxOverlayRight";

// The Air Waybill is tendered by the Indirect Air Carrier, so the shipper of
// record is Sky Courier (DHL Same Day) — not the pickup customer — and the
// shipper's account-number blank carries the IAC account number together with
// DHL's reference number for the job (both sit in that one box on the form).
const SKY_COURIER_SHIPPER =
  "SKY COURIER\n21240 RIDGE TOP CIRCLE\nSTERLING, VA 20166\nUS +1 (800) 336-3344";
const SKY_COURIER_ACCOUNT_NO = "30021-15";

// Look up a mapped field's value by label, returning null when absent/blank.
function field(mapping: DocumentMapping, label: string): string | null {
  return mapping.fields.find((f) => f.label === label)?.value ?? null;
}

type FlightLeg = {
  carrier: string | null;
  flight: string | null;
  date: string | null;
};

// "2026-06-08" / "06/08/26" -> "06/08" for the compact Flight/Date box.
function shortFlightDate(value: string | null): string | null {
  if (!value) return null;
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[2]}/${iso[3]}`;
  const md = value.match(/^(\d{1,2})\/(\d{1,2})/);
  return md ? `${md[1].padStart(2, "0")}/${md[2].padStart(2, "0")}` : value;
}

// The AWB prints two "Flight/Date" boxes to the right of the destination
// airport. Each pairs a leg's flight number (prefixed with the airline code
// when it's a real two-character carrier) with its date, e.g. "WN4394 06/08". A
// connecting itinerary fills both boxes — leg 1 then leg 2 — while a direct
// flight fills only the first. The two boxes share one AcroForm field, so each
// value is drawn as a positioned overlay (see the FLIGHT_BOX_OVERLAY keys in
// fillAwbForm).
function setAwbFlightBoxes(out: Record<string, string>, legs: FlightLeg[]) {
  const boxes = legs
    .map((leg) => {
      if (!leg.flight && !leg.date) return "";
      const code =
        leg.carrier && /^[A-Z0-9]{2}$/.test(leg.carrier) ? leg.carrier : "";
      const flight = leg.flight ? `${code}${leg.flight}` : "";
      return [flight, shortFlightDate(leg.date)].filter(Boolean).join(" ");
    })
    .filter(Boolean);
  if (boxes[0]) out[FLIGHT_BOX_OVERLAY_LEFT_KEY] = boxes[0];
  if (boxes[1]) out[FLIGHT_BOX_OVERLAY_RIGHT_KEY] = boxes[1];
}

/**
 * Translate a DHL IAC document mapping into AWB AcroForm field values.
 * Keys are the exact AcroForm field names found on the AWB form (page 3);
 * blank IAC fields are omitted so the form is only filled where we have data.
 */
export function iacToAwbValues(
  mapping: DocumentMapping,
): Record<string, string> {
  const out: Record<string, string> = {};
  const set = (name: string, value: string | null | undefined) => {
    if (value) out[name] = value;
  };

  const carrier = field(mapping, "Carrier");
  const iac = field(mapping, "IAC Number");
  const southwestFlights = identifySouthwestFlightData(mapping);

  // Southwest uses a fixed customer account number on the AWB regardless of
  // which source document we mapped from.
  set("Issuing Carriers Agent Name and City", carrier);
  set("Account No", SOUTHWEST_ACCOUNT_NO);

  // Pass through any IAC tender fields that happen to be filled in.
  set("Air Waybill Number", field(mapping, "Master Air Waybill"));
  set("Reference Number", field(mapping, "DHL Same Day Job #"));
  set("By First Carrier", field(mapping, "Airline Tendered"));
  setAwbFlightBoxes(
    out,
    southwestFlights?.legs.map((leg) => ({
      carrier: leg.carrierCode,
      flight: leg.flightNumber,
      date: leg.flightDate,
    })) ?? [
      {
        carrier: field(mapping, "Carrier"),
        flight: field(mapping, "Flight Number"),
        date: field(mapping, "Date Tendered"),
      },
    ],
  );

  // Summarise the IAC tender context in the free-text handling box.
  const handling: string[] = [];
  if (carrier || iac) {
    handling.push(
      `Tendered by Indirect Air Carrier: ${carrier ?? "DHL Same Day"}` +
        (iac ? ` (IAC ${iac})` : ""),
    );
  }
  const under16 = field(mapping, "Items under 16 oz (453.6 g)");
  if (under16) handling.push(`Items under 16 oz: ${under16}`);
  set("Handling Information", handling.join(" | "));

  return out;
}

/**
 * Translate a DHL SameDay dispatch-ticket mapping into AWB AcroForm field
 * values. The ticket carries the full shipment, so it populates the shipper,
 * consignee, routing, cargo and handling boxes directly. Keys are the exact
 * AcroForm field names on the AWB form (page 3); blank ticket fields are omitted.
 */
export function ticketToAwbValues(
  mapping: DocumentMapping,
): Record<string, string> {
  const out: Record<string, string> = {};
  const set = (name: string, value: string | null | undefined) => {
    if (value) out[name] = value;
  };

  set("Air Waybill Number", field(mapping, "Air Waybill Number"));
  // Shipper of record is the IAC (Sky Courier), not the pickup customer.
  set("Shipper Name and Address", SKY_COURIER_SHIPPER);
  // The DHL job reference ("1//<ticket#>") is printed just below the shipper's
  // account-number box. There's no AcroForm field there, so it's drawn as a
  // positioned overlay (see SHIPPER_REF_OVERLAY_KEY in fillAwbForm).
  const ticket = field(mapping, "Ticket Number");
  if (ticket) out[SHIPPER_REF_OVERLAY_KEY] = `1//${ticket}`;
  // The shipper's account-number blank carries the IAC account number only.
  set("Shippers Account Number", SKY_COURIER_ACCOUNT_NO);
  set("Consignee Name and Address", field(mapping, "Consignee Name and Address"));
  set("Issuing Carriers Agent Name and City", field(mapping, "Issuing Agent"));

  const carrier = field(mapping, "Carrier");
  const southwestFlights = identifySouthwestFlightData(mapping);
  set("Carrier1", carrier);
  const origin = field(mapping, "Origin Airport");
  const dest = field(mapping, "Destination Airport");
  set("Airport of Departure", origin);
  set("Airport of Destination", dest);

  // Requested routing, leg by leg. A connecting itinerary (e.g. ATL→MDW→SFO)
  // fills the second and third carrier boxes; a direct flight fills only the
  // first. Parsed from the "Routing" field; falls back to a single
  // origin→destination leg when that detail isn't available.
  const legs =
    southwestFlights?.legs
      .filter((leg) => leg.destination || leg.carrierCode)
      .map((leg) => ({
        des: leg.destination,
        by: leg.carrierCode,
      })) ?? [];
  if (legs.length === 0 && dest && carrier) legs.push({ des: dest, by: carrier });
  const legBoxes: Array<[string, string]> = [
    ["To", "By First Carrier"],
    ["to", "by"],
    ["to_2", "by_2"],
  ];
  legs.slice(0, legBoxes.length).forEach((leg, i) => {
    set(legBoxes[i][0], leg.des);
    set(legBoxes[i][1], leg.by);
  });

  setAwbFlightBoxes(
    out,
    southwestFlights?.legs.map((leg) => ({
      carrier: leg.carrierCode,
      flight: leg.flightNumber,
      date: leg.flightDate,
    })) ?? [
      {
        carrier: field(mapping, "Carrier"),
        flight: field(mapping, "Flight Number"),
        date: field(mapping, "Flight Date"),
      },
    ],
  );

  // No value declared for carriage.
  set("Declared Value for Carriage", "NVD");

  // Accounting box: the date/time the AWB is billed (now, in US Eastern — the
  // zone abbreviation resolves to EDT/EST automatically) plus the SWA account.
  const billedParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(new Date());
  const p = Object.fromEntries(billedParts.map((x) => [x.type, x.value]));
  set(
    "Accounting Information",
    `Billed on ${p.month}/${p.day}/${p.year} ${p.hour}:${p.minute} ${p.timeZoneName} SWA ACCOUNT 30021`,
  );

  // Piece count, gross weight and chargeable weight are left blank on the
  // Southwest AWB (filled in by the carrier at acceptance).

  // Goods description is always "Computer Parts" on the Southwest AWB,
  // regardless of the source document's actual part/description detail.
  set("Nature and Quantity of Goods", "Computer Parts");

  return out;
}

/**
 * Translate a recognised document mapping into AWB AcroForm field values, or
 * null when the document type can't fill an Air Waybill.
 */
export function mappingToAwbValues(
  mapping: DocumentMapping,
): Record<string, string> | null {
  switch (mapping.type) {
    case "dhl-iac":
      return iacToAwbValues(mapping);
    case "dhl-sameday-ticket":
      return ticketToAwbValues(mapping);
    default:
      return null;
  }
}

/**
 * Fill the AWB AcroForm with the given field values and return only the filled
 * Air Waybill page. The source template carries introductory pages ahead of the
 * actual form, and Southwest output should omit those. Unknown or non-text
 * fields are skipped rather than throwing, so a slightly different AWB
 * template won't break the fill.
 */
export async function fillAwbForm(
  pdfBytes: Uint8Array,
  values: Record<string, string>,
): Promise<{ bytes: Uint8Array; filled: string[]; skipped: string[] }> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const doc = await PDFDocument.load(pdfBytes);
  const form = doc.getForm();

  // Pull out the reserved overlay value; everything else is an AcroForm field.
  const shipperRef = values[SHIPPER_REF_OVERLAY_KEY];
  const flightBoxLeft = values[FLIGHT_BOX_OVERLAY_LEFT_KEY];
  const flightBoxRight = values[FLIGHT_BOX_OVERLAY_RIGHT_KEY];
  const flightBoxRects =
    flightBoxLeft || flightBoxRight
      ? form
          .getTextField("Flight Date")
          .acroField.getWidgets()
          .map((widget) => widget.getRectangle())
          .sort((a, b) => a.x - b.x)
      : [];

  const filled: string[] = [];
  const skipped: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    if (
      name === SHIPPER_REF_OVERLAY_KEY ||
      name === FLIGHT_BOX_OVERLAY_LEFT_KEY ||
      name === FLIGHT_BOX_OVERLAY_RIGHT_KEY
    ) {
      continue;
    }
    try {
      const tf = form.getTextField(name);
      tf.setText(value);
      filled.push(name);
    } catch {
      skipped.push(name);
    }
  }

  // Keep the typed-in values visible in viewers that don't regenerate
  // appearances, without locking the form.
  form.updateFieldAppearances();

  // The actual AWB AcroForm is page 3 of the template; flatten the form and
  // return just that page so generated Southwest packets don't include the two
  // preceding instruction/content pages.
  form.flatten();
  const out = await PDFDocument.create();
  const awbPageIndex = Math.min(2, doc.getPageCount() - 1);
  const [page] = await out.copyPages(doc, [awbPageIndex]);
  out.addPage(page);

  // Mark the prepaid charge boxes with an "X", as on the properly-completed
  // Southwest AWB: the WT/VAL and Other charges are both prepaid (CHGS Code
  // "PP"), so each gets an X in its PPD column. The Other-PPD box has no
  // AcroForm field, so both marks are drawn as an overlay at the box centres
  // (page-3 coordinates, PDF points, bottom-left origin).
  const xFont = await out.embedFont(StandardFonts.HelveticaBold);
  for (const x of [364.2, 392.9]) {
    page.drawText("X", { x, y: 501, size: 10, font: xFont, color: rgb(0, 0, 0) });
  }

  // DHL job reference, just below the shipper's account-number box (which sits
  // at x=189, y=736..754); drawn here because the form has no field there.
  if (shipperRef) {
    const refFont = await out.embedFont(StandardFonts.Helvetica);
    page.drawText(shipperRef, {
      x: 191,
      y: 724,
      size: 9,
      font: refFont,
      color: rgb(0, 0, 0),
    });
  }

  if (flightBoxRects.length > 0) {
    const flightFont = await out.embedFont(StandardFonts.Helvetica);
    const overlayBoxes = [flightBoxLeft, flightBoxRight];
    overlayBoxes.forEach((value, index) => {
      const rect = flightBoxRects[index];
      if (!value || !rect) return;
      page.drawText(value, {
        x: rect.x + 2,
        y: rect.y + 1.5,
        size: 8,
        font: flightFont,
        color: rgb(0, 0, 0),
      });
    });
  }

  const bytes = await out.save();
  return { bytes, filled, skipped };
}
