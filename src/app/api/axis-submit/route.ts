import { NextRequest, NextResponse } from "next/server";
import type { DocumentMapping } from "@/lib/documents";
import {
  axisConfigFromEnv,
  AxisError,
  resolveServiceId,
  resolveVehicleId,
  submitOrders,
} from "@/lib/axis";
import {
  AXIS_SUBMITTABLE_TYPES,
  mappingToAxisOrder,
  type AxisOrderDefaults,
} from "@/lib/axis-map";
import { appendLoggedOrders, type LoggedOrder } from "@/lib/order-log";

// Talks to the Axis ClientPortal over the network from the server (keeps
// credentials off the client), so force the Node.js runtime.
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let mappings: DocumentMapping[];
  let dryRun = false;
  try {
    const body = await req.json();
    mappings = Array.isArray(body.mappings)
      ? body.mappings
      : body.mapping
        ? [body.mapping]
        : [];
    dryRun = body.dryRun === true;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (mappings.length === 0) {
    return NextResponse.json(
      { error: "No document mappings provided." },
      { status: 400 },
    );
  }

  const cfg = axisConfigFromEnv();

  // Dry run: build and return the order draft that will be converted to the
  // ClientPortal SubmitOrder payload, without authenticating or sending
  // anything. Missing ids fall back to 0 so the shape is still previewable.
  if (dryRun) {
    const previewDefaults: AxisOrderDefaults = {
      accountNo: cfg.accountNo ?? "(portal account)",
      serviceId: cfg.serviceId ?? 0,
      vehicleId: cfg.vehicleId ?? 0,
      packageId: cfg.packageId ?? 0,
      caller: cfg.caller,
    };
    const previewOrders = [];
    const previewSkipped: string[] = [];
    for (const mapping of mappings) {
      const order = mappingToAxisOrder(mapping, previewDefaults);
      if (order) previewOrders.push(order);
      else previewSkipped.push(mapping?.type ?? "unknown");
    }
    const placeholders: string[] = [];
    if (cfg.serviceId === undefined) placeholders.push("ServiceId");
    if (cfg.vehicleId === undefined) placeholders.push("VehicleId");
    if (cfg.packageId === undefined) placeholders.push("PackageId");
    return NextResponse.json({
      dryRun: true,
      endpoint: "POST /ClientPortal/ClientPortal/api/newOrderOnline/SubmitOrder",
      orders: previewOrders,
      skipped: previewSkipped,
      placeholders,
    });
  }

  // An order needs portal credentials. Service/vehicle ids are resolved from the
  // caller defaults automatically (below) unless overridden in config.
  const missing: string[] = [];
  if (!(cfg.username && cfg.password)) missing.push("AXIS_USERNAME + AXIS_PASSWORD");
  if (missing.length > 0) {
    return NextResponse.json(
      { error: `Axis is not configured. Set: ${missing.join(", ")}.` },
      { status: 400 },
    );
  }

  // Bail before any API call if nothing here can become an order.
  const submittable = mappings.filter((m) =>
    AXIS_SUBMITTABLE_TYPES.has(m?.type),
  );
  const skipped = mappings
    .filter((m) => !AXIS_SUBMITTABLE_TYPES.has(m?.type))
    .map((m) => m?.type ?? "unknown");
  if (submittable.length === 0) {
    return NextResponse.json(
      {
        error: `Nothing to submit. Axis orders can only be created from: ${[...AXIS_SUBMITTABLE_TYPES].join(", ")}.`,
        skipped,
      },
      { status: 400 },
    );
  }

  try {
    // Resolve the service/vehicle ids (configured override, else looked up from
    // the account). These are authenticated calls, so they also validate the token.
    const [serviceId, vehicleId] = await Promise.all([
      resolveServiceId(cfg),
      resolveVehicleId(cfg),
    ]);
    const defaults: AxisOrderDefaults = {
      accountNo: cfg.accountNo ?? "",
      serviceId,
      vehicleId,
      packageId: cfg.packageId ?? 0,
      caller: cfg.caller,
    };

    const orders = submittable
      .map((mapping) => mappingToAxisOrder(mapping, defaults))
      .filter((o): o is NonNullable<typeof o> => o !== null);

    const result = await submitOrders(orders, cfg);
    const ordersCreated = result.OrdersCreated ?? [];

    // Record each created order to the persistent log that powers the
    // "today's orders" view. Best-effort — never fail the submit over logging.
    const submittedAt = new Date().toISOString();
    const entries: LoggedOrder[] = orders
      .map((o, i) => ({
        orderTrackingId: String(ordersCreated[i] ?? ""),
        submittedAt,
        accountNo: o.AccountNo,
        serviceId: o.ServiceId,
        vehicleId: o.VehicleId,
        clientRefNo: o.ClientRefNo,
        clientRefNo2: o.ClientRefNo2,
        pickup: o.PCoName,
        delivery: o.DCoName,
        specInstr: o.SpecInstr,
      }))
      .filter((e) => e.orderTrackingId);
    await appendLoggedOrders(entries);

    return NextResponse.json({
      ok: true,
      submitted: orders.length,
      ordersCreated,
      skipped,
    });
  } catch (err) {
    const status = err instanceof AxisError && err.status ? err.status : 502;
    console.error("Axis submit failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to submit to Axis." },
      { status },
    );
  }
}
