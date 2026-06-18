// Map a parsed document (a DHL SameDay / Sky Courier dispatch ticket) onto an
// Axis SubmitOrders v4 request. The ticket carries the full shipment — shipper
// (pickup), consignee (delivery), cargo and routing — so it becomes one order.
//
// Pure and dependency-free (no env, no network) so it can be unit-tested; the
// deployment-specific ids (account, service, vehicle, package) are passed in.

import type { DocumentMapping } from "./documents";
import type { OrderPackageItemV4, SubmitOrderV4Request } from "./axis";
import { identifySouthwestFlightData } from "./southwest-flight-data";

// Document types we know how to turn into an Axis order. Only the dispatch
// ticket carries a full shipment; the IAC certification does not.
export const AXIS_SUBMITTABLE_TYPES = new Set(["dhl-sameday-ticket"]);

/** Order-field defaults that come from configuration, not the document. */
export type AxisOrderDefaults = {
  accountNo: string;
  serviceId: number;
  vehicleId: number;
  /** Package type id; required to attach weight/dimensions to the order. */
  packageId?: number;
  caller?: string;
  orderType?: SubmitOrderV4Request["OrderType"];
};

// Look up a mapped field's value by label, returning null when absent/blank.
function field(mapping: DocumentMapping, label: string): string | null {
  return mapping.fields.find((f) => f.label === label)?.value ?? null;
}

// Parse a number out of a free-text value ("12 lb", "3", "10.5"), or undefined.
function num(value: string | null): number | undefined {
  if (!value) return undefined;
  const m = value.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!m) return undefined;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : undefined;
}

// "10 x 8 x 6" -> { length: 10, width: 8, height: 6 }.
function parseDimensions(value: string | null): {
  length?: number;
  width?: number;
  height?: number;
} {
  if (!value) return {};
  const parts = value.split(/[x×]/i).map((p) => num(p));
  return { length: parts[0], width: parts[1], height: parts[2] };
}

type ParsedAddress = {
  coName?: string;
  contact?: string;
  phone?: string;
  street?: string;
  street2?: string;
  city?: string;
  state?: string;
  zip?: string;
  /** Lines we couldn't classify, preserved so nothing is silently dropped. */
  extra?: string;
};

// Turn a composed multi-line address block (as produced by composeAddress in
// documents.ts) back into structured Axis fields. The block looks like:
//   ACME CORP
//   123 MAIN ST
//   ATLANTA, GA 30303
//   Attn: John Doe
//   Tel: (404) 555-1212
// Best-effort: name is the first line, "City, ST ZIP" is matched anywhere,
// "Attn/Contact" is pulled out, and any leftover lines become street/extra.
function parseAddressBlock(raw: string | null): ParsedAddress {
  if (!raw) return {};
  let lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const out: ParsedAddress = {};

  // Phone: a "Tel:" line, or any line that is mostly a phone number.
  const telIdx = lines.findIndex((l) => /^tel\b/i.test(l));
  if (telIdx !== -1) {
    out.phone = lines[telIdx].replace(/^tel[:.]?\s*/i, "").trim() || undefined;
    lines.splice(telIdx, 1);
  }

  // Contact: an "Attn"/"Attention"/"Contact" line.
  const attnIdx = lines.findIndex((l) => /^(attn|attention|contact)\b/i.test(l));
  if (attnIdx !== -1) {
    out.contact = lines[attnIdx].replace(/^(attn|attention|contact)[:.]?\s*/i, "").trim() || undefined;
    lines.splice(attnIdx, 1);
  }

  // City, State ZIP: "Atlanta, GA 30303" / "Atlanta GA 30303-1234".
  const cszIdx = lines.findIndex((l) =>
    /^.+[, ]\s*[A-Za-z]{2}\.?\s+\d{5}(?:-\d{4})?$/.test(l),
  );
  if (cszIdx !== -1) {
    const m = lines[cszIdx].match(/^(.*?)[, ]\s*([A-Za-z]{2})\.?\s+(\d{5}(?:-\d{4})?)$/);
    if (m) {
      out.city = m[1].replace(/,\s*$/, "").trim() || undefined;
      out.state = m[2].toUpperCase();
      out.zip = m[3];
    }
    // Anything after the city/state/zip line (e.g. a country) is "extra".
    const after = lines.slice(cszIdx + 1);
    if (after.length) out.extra = after.join(", ");
    lines = lines.slice(0, cszIdx);
  }

  // First remaining line is the company/name; the rest are street lines.
  if (lines.length) {
    out.coName = lines[0];
    const streetLines = lines.slice(1);
    if (streetLines[0]) out.street = streetLines[0];
    if (streetLines.length > 1) out.street2 = streetLines.slice(1).join(", ");
  }

  return out;
}

// Join non-empty parts into a single instruction line.
function joinInstr(parts: Array<string | null | undefined>): string | undefined {
  const v = parts.filter((p): p is string => Boolean(p && p.trim())).join(" | ");
  return v || undefined;
}

// Join non-empty parts with " / " (the Delta delivery-instruction format).
function joinSlash(parts: Array<string | null | undefined>): string | undefined {
  const v = parts.filter((p): p is string => Boolean(p && p.trim())).join(" / ");
  return v || undefined;
}

// Air-cargo shipments are tendered to the airline's cargo counter, so the Axis
// delivery stop is that counter — not the shipment's final consignee (which the
// airline carries to the destination airport). Keyed by airline (IATA) code.
type CargoHub = {
  coName: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  /** Whether to append the airline AWB to the delivery instructions (Delta does). */
  includeAwb: boolean;
};

const CARGO_HUBS: Record<string, CargoHub> = {
  DL: {
    coName: "Delta Dash",
    street: "6000 N Terminal Pkwy",
    city: "Atlanta",
    state: "GA",
    zip: "30320",
    includeAwb: true,
  },
  WN: {
    coName: "SOUTHWEST",
    street: "3400 N Inner Loop Rd",
    city: "Atlanta",
    state: "GA",
    zip: "30354",
    includeAwb: false,
  },
};

// The airline (IATA) code a ticket is tendered to: the parsed carrier code, or
// the airline name when the code is absent. Null when not an airline tender.
function routingCarrierCode(mapping: DocumentMapping): string | null {
  const carrier = (field(mapping, "Carrier") ?? "").trim().toUpperCase();
  if (/^[A-Z0-9]{2}$/.test(carrier)) return carrier;
  const airline = field(mapping, "Airline Tendered") ?? "";
  if (/\bdelta\b/i.test(airline)) return "DL";
  if (/\bsouthwest\b/i.test(airline)) return "WN";
  return null;
}

// Build the delivery special-instruction text, one line per flight leg:
//   "WN4394 / DAL <<<"   (connecting leg — "<<<" marks a transfer)
//   "WN2451 / LBB"       (final leg)
// When includeAwb is set (Delta), the airline AWB is appended to the last leg:
//   "DL4644 / MLI / 78512324"
// Flight times aren't extracted from the ticket yet, so they're omitted.
function airlineDeliveryInstr(
  mapping: DocumentMapping,
  includeAwb: boolean,
): string | undefined {
  const data = identifySouthwestFlightData(mapping);
  const legs = (data?.legs ?? []).filter(
    (l) => l.flightNumber || l.destination,
  );
  if (legs.length === 0) return undefined;

  const lines = legs
    .map((leg, i) => {
      const code =
        leg.carrierCode && /^[A-Za-z0-9]{2}$/.test(leg.carrierCode)
          ? leg.carrierCode.toUpperCase()
          : "";
      const flightCode = leg.flightNumber ? `${code}${leg.flightNumber}` : code || null;
      const isLast = i === legs.length - 1;
      const parts = [flightCode, leg.destination];
      if (includeAwb && isLast && leg.airWaybillNumber) parts.push(leg.airWaybillNumber);
      const line = joinSlash(parts);
      if (!line) return null;
      return isLast ? line : `${line} <<<`;
    })
    .filter((l): l is string => Boolean(l));

  return lines.length ? lines.join("\n") : undefined;
}

/**
 * Build a v4 SubmitOrders request from a recognised document mapping, or null
 * when the document type can't become an order.
 */
export function mappingToAxisOrder(
  mapping: DocumentMapping,
  defaults: AxisOrderDefaults,
): SubmitOrderV4Request | null {
  if (!AXIS_SUBMITTABLE_TYPES.has(mapping.type)) return null;

  const pickup = parseAddressBlock(field(mapping, "Shipper Name and Address"));
  const delivery = parseAddressBlock(field(mapping, "Consignee Name and Address"));

  const awb = field(mapping, "Air Waybill Number");
  const ticket = field(mapping, "Ticket Number");
  const reference = field(mapping, "Reference Number");
  const partNumber = field(mapping, "Part Number");

  const order: SubmitOrderV4Request = {
    OrderType: defaults.orderType ?? "PD",
    AccountNo: defaults.accountNo,
    ServiceId: defaults.serviceId,
    VehicleId: defaults.vehicleId,
    Caller: defaults.caller,

    // Reference numbers, most specific first.
    ClientRefNo: reference ?? awb ?? ticket ?? undefined,
    ClientRefNo2: awb ?? undefined,
    ClientRefNo3: ticket ?? undefined,
    ClientRefNo4: partNumber ?? undefined,

    // Pickup = shipper.
    PCoName: pickup.coName,
    PContact: pickup.contact,
    PPhone: pickup.phone,
    PStreet: pickup.street,
    PStreet2: pickup.street2,
    PCity: pickup.city,
    PState: pickup.state,
    PZip: pickup.zip,
    PSpecInstr: pickup.extra,

    // Delivery = consignee.
    DCoName: delivery.coName,
    DContact: delivery.contact,
    DPhone: delivery.phone,
    DStreet: delivery.street,
    DStreet2: delivery.street2,
    DCity: delivery.city,
    DState: delivery.state,
    DZip: delivery.zip,
    DSpecInstr: delivery.extra,

    // Free-text summary of the air movement (no dedicated v4 fields for it).
    SpecInstr: joinInstr([
      field(mapping, "Description"),
      summarizeRouting(mapping),
      partNumber ? `Part# ${partNumber}` : null,
    ]),
  };

  // Air-cargo routing (Delta, Southwest, …): the delivery stop is the airline's
  // cargo counter, not the shipment's final consignee. Redirect the delivery
  // address to the airline hub and carry the flight legs (and AWB, for Delta)
  // in the delivery special instructions.
  const hub = CARGO_HUBS[routingCarrierCode(mapping) ?? ""];
  if (hub) {
    order.DCoName = hub.coName;
    order.DContact = undefined;
    order.DPhone = undefined;
    order.DEmail = undefined;
    order.DStreet = hub.street;
    order.DStreet2 = undefined;
    order.DCity = hub.city;
    order.DState = hub.state;
    order.DZip = hub.zip;
    order.DSpecInstr = airlineDeliveryInstr(mapping, hub.includeAwb) ?? order.DSpecInstr;
  }

  // Weight / dimensions live on a package item, which needs a package-type id.
  const piece = num(field(mapping, "Pieces"));
  const weight = num(field(mapping, "Gross Weight (lb)"));
  const dims = parseDimensions(field(mapping, "Dimensions (in)"));
  const hasCargo = weight !== undefined || dims.length !== undefined;
  if (defaults.packageId !== undefined && hasCargo) {
    const item: OrderPackageItemV4 = {
      PackageId: defaults.packageId,
      Leg_PD: true,
      Count: piece,
      RefNo: awb ?? reference ?? undefined,
      Weight: weight,
      Length: dims.length,
      Width: dims.width,
      Height: dims.height,
    };
    order.OrderPackageItems = [item];
  } else if (hasCargo) {
    // No package-type id configured: keep weight/dims visible in instructions.
    order.SpecInstr = joinInstr([
      order.SpecInstr,
      piece ? `${piece} pc` : null,
      weight ? `${weight} lb` : null,
      field(mapping, "Dimensions (in)") ? `${field(mapping, "Dimensions (in)")} in` : null,
    ]);
  }

  // Strip undefined keys so the JSON payload only carries what we actually have.
  return Object.fromEntries(
    Object.entries(order).filter(([, v]) => v !== undefined),
  ) as unknown as SubmitOrderV4Request;
}

// "ATL -> BOS via DL 0987 on 2026-06-08" style summary from the routing fields.
function summarizeRouting(mapping: DocumentMapping): string | null {
  const origin = field(mapping, "Origin Airport");
  const dest = field(mapping, "Destination Airport");
  const airline = field(mapping, "Airline Tendered") ?? field(mapping, "Carrier");
  const flight = field(mapping, "Flight Number");
  const date = field(mapping, "Flight Date");

  const route = origin && dest ? `${origin}->${dest}` : origin || dest || null;
  if (!route && !flight) return null;
  const via = [airline, flight].filter(Boolean).join(" ");
  return [route, via ? `via ${via}` : null, date ? `on ${date}` : null]
    .filter(Boolean)
    .join(" ");
}
