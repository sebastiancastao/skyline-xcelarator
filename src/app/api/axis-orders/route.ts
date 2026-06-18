import { NextRequest, NextResponse } from "next/server";
import { getLoggedOrders, getOrdersForDay } from "@/lib/order-log";

// Reads the persistent order log from disk.
export const runtime = "nodejs";

// GET /api/axis-orders            -> orders submitted today (server local day)
// GET /api/axis-orders?day=YYYY-MM-DD -> orders for that local day
// GET /api/axis-orders?all=1      -> every logged order
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const tz = process.env.AXIS_DEVICE_TIMEZONE_IANA || undefined;

  if (searchParams.get("all") === "1") {
    const orders = await getLoggedOrders();
    return NextResponse.json({ scope: "all", orders });
  }

  const day = searchParams.get("day") || undefined;
  const orders = await getOrdersForDay(day, tz);
  // Echo the resolved day so the client can label the list.
  const resolvedDay =
    day ??
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());

  return NextResponse.json({ scope: "day", day: resolvedDay, orders });
}
