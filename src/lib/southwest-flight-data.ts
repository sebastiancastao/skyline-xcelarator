import type { DocumentMapping } from "./documents";

export type SouthwestFlightLeg = {
  index: number;
  origin: string | null;
  destination: string | null;
  carrierCode: string | null;
  carrierName: string | null;
  flightNumber: string | null;
  flightDate: string | null;
  airWaybillNumber: string | null;
};

export type SouthwestFlightData = {
  legs: SouthwestFlightLeg[];
  summary: {
    airWaybillNumbers: string | null;
    flightDates: string | null;
    flightNumbers: string | null;
    flightNumbersCompact: string | null;
  };
};

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

function field(mapping: DocumentMapping, label: string): string | null {
  return mapping.fields.find((f) => f.label === label)?.value ?? null;
}

function firstField(mapping: DocumentMapping, labels: string[]): string | null {
  for (const label of labels) {
    const value = field(mapping, label);
    if (value) return value;
  }
  return null;
}

function splitCompoundValue(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(/\s*\/\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function airlineName(code: string | null): string | null {
  if (!code) return null;
  return AIRLINE_NAMES[code.toUpperCase()] ?? code;
}

function joinValues(
  values: Array<string | null>,
  separator: string,
): string | null {
  const parts = values.filter((value): value is string => Boolean(value));
  return parts.length ? parts.join(separator) : null;
}

function parseRoutingLegs(value: string | null): Array<{
  origin: string;
  destination: string;
  carrierCode: string;
}> {
  if (!value) return [];
  return [...value.matchAll(/([A-Z]{3})-([A-Z]{3})\s+([A-Z0-9]{2})\s+\S+/g)].map(
    (match) => ({
      origin: match[1],
      destination: match[2],
      carrierCode: match[3],
    }),
  );
}

// Southwest prints from this explicit per-leg structure rather than guessing
// from the slash-joined field strings inside the PDF filler.
export function identifySouthwestFlightData(
  mapping: DocumentMapping,
): SouthwestFlightData | null {
  const routingLegs = parseRoutingLegs(field(mapping, "Routing"));
  const flightNumbers = splitCompoundValue(field(mapping, "Flight Number"));
  const flightDates = splitCompoundValue(
    firstField(mapping, ["Flight Date", "Date Tendered"]),
  );
  const airWaybillNumbers = splitCompoundValue(
    firstField(mapping, ["Air Waybill Number", "Master Air Waybill"]),
  );

  const legCount = Math.max(
    routingLegs.length,
    flightNumbers.length,
    flightDates.length,
    airWaybillNumbers.length,
  );
  if (legCount === 0) return null;

  const originAirport = field(mapping, "Origin Airport");
  const destinationAirport = field(mapping, "Destination Airport");
  const defaultCarrierCode = field(mapping, "Carrier");
  const defaultCarrierName = firstField(mapping, [
    "Airline Tendered",
    "Carrier",
  ]);

  const legs: SouthwestFlightLeg[] = Array.from({ length: legCount }, (_, i) => {
    const routingLeg = routingLegs[i];
    return {
      index: i + 1,
      origin: routingLeg?.origin ?? (i === 0 ? originAirport : null),
      destination:
        routingLeg?.destination ?? (i === legCount - 1 ? destinationAirport : null),
      carrierCode: routingLeg?.carrierCode ?? defaultCarrierCode,
      carrierName:
        airlineName(routingLeg?.carrierCode ?? null) ?? defaultCarrierName,
      flightNumber: flightNumbers[i] ?? null,
      flightDate: flightDates[i] ?? null,
      airWaybillNumber:
        airWaybillNumbers[i] ??
        (airWaybillNumbers.length === 1 ? airWaybillNumbers[0] : null),
    };
  });

  return {
    legs,
    summary: {
      airWaybillNumbers: joinValues(
        legs.map((leg) => leg.airWaybillNumber),
        " / ",
      ),
      flightDates: joinValues(legs.map((leg) => leg.flightDate), " / "),
      flightNumbers: joinValues(legs.map((leg) => leg.flightNumber), " / "),
      flightNumbersCompact: joinValues(
        legs.map((leg) => leg.flightNumber),
        "/",
      ),
    },
  };
}
