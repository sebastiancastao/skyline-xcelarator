// Server-side client for Skyline Courier & Logistics' Xcelerator ClientPortal.
//
// The public Swagger "Axis" API documents POST /v4/Order/SubmitOrders, but this
// deployment's caller credentials are portal credentials: username/password ->
// ASP.NET session cookie -> internal ClientPortal API. This file mirrors the
// same flow the portal uses:
//   1. login at /Xcelerator/ClientPortal
//   2. open /ClientPortal/NewOrder/NewOrder to get a fresh OrderTrackingID
//   3. validate the order through newOrderOnline endpoints
//   4. POST newOrderOnline/SubmitOrder
//
// Server-only: reads credentials from the environment and must never run in the
// browser.

// --- Order draft models -----------------------------------------------------

export type AxisOrderType = "PD" | "PH" | "HH" | "HD" | "SS";

export type OrderPackageItemV4 = {
  /** Portal package-type id. 0 means "use the portal default package id". */
  PackageId: number;
  PackageName?: string;
  /** Number of pieces for this package line. */
  Count?: number;
  RefNo?: string;
  RefNo2?: string;
  Weight?: number; // total lb for the line
  Length?: number; // in
  Width?: number; // in
  Height?: number; // in
  Leg_PD?: boolean;
};

export type SubmitOrderV4Request = {
  OrderType?: AxisOrderType;
  AccountNo: string;
  ServiceId: number;
  VehicleId: number;
  Caller?: string;
  Department?: string;
  Phone?: string;
  Email?: string;
  SpecInstr?: string;
  ClientRefNo?: string;
  ClientRefNo2?: string;
  ClientRefNo3?: string;
  ClientRefNo4?: string;
  // Pickup location.
  PCoName?: string;
  PContact?: string;
  PPhone?: string;
  PEmail?: string;
  PStreet?: string;
  PStreet2?: string;
  PCity?: string;
  PState?: string;
  PZip?: string;
  PSpecInstr?: string;
  // Delivery location.
  DCoName?: string;
  DContact?: string;
  DPhone?: string;
  DEmail?: string;
  DStreet?: string;
  DStreet2?: string;
  DCity?: string;
  DState?: string;
  DZip?: string;
  DSpecInstr?: string;
  sValue?: number;
  OrderPackageItems?: OrderPackageItemV4[];
};

export type SubmitOrderResponseV4 = {
  OrdersCreated: Array<string | number>;
};

// --- Config -----------------------------------------------------------------

export type AxisConfig = {
  /** Base Xcelerator URL, no trailing slash. */
  portalBaseUrl: string;
  username?: string;
  password?: string;
  accountNo?: string;
  serviceId?: number;
  vehicleId?: number;
  packageId?: number;
  caller?: string;
};

const DEFAULT_PORTAL_BASE_URL = "https://skylinecourierlogistics.com/Xcelerator";

function intEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

function portalBaseUrlFromEnv(): string {
  if (process.env.AXIS_PORTAL_BASE_URL) {
    return process.env.AXIS_PORTAL_BASE_URL.replace(/\/+$/, "");
  }

  // Backwards compatibility with the earlier direct-API config. If it points at
  // ".../Xcelerator/Axis", strip the Axis segment to get the portal root.
  const apiBase = process.env.AXIS_API_BASE_URL?.replace(/\/+$/, "");
  if (apiBase) return apiBase.replace(/\/Axis$/i, "");

  return DEFAULT_PORTAL_BASE_URL;
}

/** Build an AxisConfig from environment variables. */
export function axisConfigFromEnv(): AxisConfig {
  return {
    portalBaseUrl: portalBaseUrlFromEnv(),
    username: process.env.AXIS_USERNAME || undefined,
    password: process.env.AXIS_PASSWORD || undefined,
    accountNo: process.env.AXIS_ACCOUNT_NO || undefined,
    serviceId: intEnv("AXIS_SERVICE_ID"),
    vehicleId: intEnv("AXIS_VEHICLE_ID"),
    packageId: intEnv("AXIS_PACKAGE_ID"),
    caller: process.env.AXIS_CALLER || undefined,
  };
}

// --- Errors -----------------------------------------------------------------

export class AxisError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "AxisError";
    this.status = status;
  }
}

// --- Portal session ---------------------------------------------------------

type PortalSession = {
  cfg: AxisConfig;
  jar: CookieJar;
};

class CookieJar {
  private values = new Map<string, string>();

  header(): string {
    return [...this.values.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  capture(headers: Headers) {
    const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
    const rawCookies =
      typeof withGetSetCookie.getSetCookie === "function"
        ? withGetSetCookie.getSetCookie()
        : splitSetCookieHeader(headers.get("set-cookie"));

    for (const raw of rawCookies) {
      const first = raw.split(";", 1)[0]?.trim();
      if (!first) continue;
      const eq = first.indexOf("=");
      if (eq <= 0) continue;
      const name = first.slice(0, eq);
      const value = first.slice(eq + 1);
      if (/;\s*(max-age=0|expires=thu,\s*01 jan 1970)/i.test(raw)) {
        this.values.delete(name);
      } else {
        this.values.set(name, value);
      }
    }
  }
}

function splitSetCookieHeader(value: string | null): string[] {
  if (!value) return [];
  // Split on commas that start another cookie, not the comma inside Expires.
  return value.split(/,(?=\s*[^;,\s]+=)/g).map((v) => v.trim());
}

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`${name}=(["'])(.*?)\\1`, "i"));
  return m ? decodeHtml(m[2]) : undefined;
}

function parseFormInputs(html: string, formId: string): Record<string, string> {
  const form =
    html.match(new RegExp(`<form[^>]*id=(["'])${formId}\\1[\\s\\S]*?</form>`, "i"))?.[0] ??
    html;
  const values: Record<string, string> = {};
  for (const m of form.matchAll(/<input\b[^>]*>/gi)) {
    const name = attr(m[0], "name");
    if (name) values[name] = attr(m[0], "value") ?? "";
  }
  return values;
}

function portalPathFromLocation(cfg: AxisConfig, location: string): string {
  const url = new URL(location, `${cfg.portalBaseUrl}/ClientPortal`);
  const basePath = new URL(cfg.portalBaseUrl).pathname.replace(/\/+$/, "");
  const path = url.pathname.startsWith(basePath)
    ? url.pathname.slice(basePath.length) || "/"
    : url.pathname;
  return `${path}${url.search}`;
}

async function portalFetch(
  session: PortalSession,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  const cookie = session.jar.header();
  if (cookie) headers.set("Cookie", cookie);

  const res = await fetch(`${session.cfg.portalBaseUrl}${path}`, {
    ...init,
    headers,
  });
  session.jar.capture(res.headers);
  return res;
}

async function portalJson<T>(
  session: PortalSession,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await portalFetch(session, path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...init.headers,
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new AxisError(
      `ClientPortal ${path} failed (HTTP ${res.status}): ${text.slice(0, 300)}`,
      res.status,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AxisError(`ClientPortal ${path} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

async function postPortalJson<T>(
  session: PortalSession,
  path: string,
  data: unknown,
): Promise<T> {
  return portalJson<T>(session, path, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(data),
  });
}

async function loginToPortal(cfg: AxisConfig = axisConfigFromEnv()): Promise<PortalSession> {
  if (!cfg.username || !cfg.password) {
    throw new AxisError("Axis portal is not configured. Set AXIS_USERNAME and AXIS_PASSWORD.");
  }

  const session: PortalSession = { cfg, jar: new CookieJar() };
  const loginPath = "/ClientPortal";

  const loginPage = await portalFetch(session, loginPath, {
    headers: { Accept: "text/html" },
  });
  const loginHtml = await loginPage.text();
  if (!loginPage.ok) {
    throw new AxisError(`Axis portal login page failed (HTTP ${loginPage.status}).`, loginPage.status);
  }

  const form = parseFormInputs(loginHtml, "loginForm");
  form["loginModel.UserName"] = cfg.username;
  form["loginModel.Password"] = cfg.password;

  const res = await portalFetch(session, loginPath, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `${cfg.portalBaseUrl}${loginPath}`,
    },
    body: new URLSearchParams(form),
  });
  let text = "";
  let status = res.status;
  if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
    const nextPath = portalPathFromLocation(cfg, res.headers.get("location")!);
    const finalRes = await portalFetch(session, nextPath, {
      headers: {
        Accept: "text/html",
        Referer: `${cfg.portalBaseUrl}${loginPath}`,
      },
    });
    status = finalRes.status;
    text = await finalRes.text();
  } else {
    text = await res.text();
  }

  if (status < 200 || status >= 300) {
    throw new AxisError(`Axis portal login failed (HTTP ${status}).`, status);
  }

  if (!session.jar.has("Xcelerator.ClientPortal") && /id=["']loginForm["']/i.test(text)) {
    throw new AxisError("Axis portal login failed; check AXIS_USERNAME and AXIS_PASSWORD.");
  }

  return session;
}

// --- Portal context and reference data -------------------------------------

type PortalListItem = {
  Value?: number | string;
  Text?: string;
  StrValue?: string | null;
};

type PortalListResponse = {
  Data?: PortalListItem[];
};

type ControlPrefs = {
  Caller?: string;
  Phone?: string;
  Email?: string;
  Department?: string;
  ServiceID?: number;
  VehicleID?: number;
};

type PackageControlPrefs = {
  OE_DefaultPackageID?: number;
  OE_DefaultPackageCount?: number;
};

type NewOrderContext = {
  orderTrackingId: string;
  userId: string;
  clientId: string;
  accountNo: string;
  terminalId: string;
  login: string;
  usePackageItems: string;
  myPaddedTimestamp: string;
  terminalPhone: string;
  viewAmount: string;
  cod: string;
  saveAllAsPrivateAddress: string;
  addrVerifInUse: string;
  addrVerifReturnZip4: string;
  addrVerifAllowInvalid: string;
  restrictVehicleEncroachmentOnline: string;
  autoInsertPTime: string;
  rootPublicDomainAddress: string;
  isNewOrder: string;
  callerName: string;
  prefs: ControlPrefs;
  packagePrefs: PackageControlPrefs;
};

function jsString(html: string, name: string, fallback = ""): string {
  const re = new RegExp(`${name}\\s*=\\s*'([^']*)'`, "gi");
  let value = fallback;
  for (const match of html.matchAll(re)) value = decodeHtml(match[1]);
  return value;
}

function hiddenValue(html: string, id: string, fallback = ""): string {
  const m = html.match(new RegExp(`<input[^>]+id=(["'])${id}\\1[^>]*>`, "i"));
  return m ? attr(m[0], "value") ?? fallback : fallback;
}

async function loadNewOrderContext(session: PortalSession): Promise<NewOrderContext> {
  const res = await portalFetch(session, "/ClientPortal/NewOrder/NewOrder", {
    headers: {
      Accept: "text/html",
      Referer: `${session.cfg.portalBaseUrl}/ClientPortal/ClientPortal/Main`,
    },
  });
  const html = await res.text();
  if (!res.ok) {
    throw new AxisError(`Failed to open Axis NewOrder page (HTTP ${res.status}).`, res.status);
  }

  const [controlPrefs, packagePrefs] = await Promise.all([
    portalJson<{ Data?: ControlPrefs[] }>(
      session,
      "/ClientPortal/ClientPortal/api/newOrderOnline/requestcontrolprefs",
    ),
    portalJson<PackageControlPrefs>(
      session,
      "/ClientPortal/ClientPortal/api/newOrderOnline/requestpackagecontrolprefs",
    ),
  ]);

  const orderTrackingId = jsString(html, "orderTrackingID");
  if (!orderTrackingId) {
    throw new AxisError("Axis NewOrder page did not provide an OrderTrackingID.");
  }

  return {
    orderTrackingId,
    userId: jsString(html, "userID"),
    clientId: jsString(html, "clientID"),
    accountNo: jsString(html, "accountNo", session.cfg.accountNo ?? ""),
    terminalId: jsString(html, "terminalID"),
    login: jsString(html, "login", session.cfg.username ?? ""),
    usePackageItems: jsString(html, "usePackageItems", "1"),
    myPaddedTimestamp: jsString(html, "myPaddedTimestamp"),
    terminalPhone: jsString(html, "terminalPhone"),
    viewAmount: jsString(html, "viewAmount", "True"),
    cod: jsString(html, "cod", "False"),
    saveAllAsPrivateAddress: jsString(html, "saveAllAsPrivateAddress", "0"),
    addrVerifInUse: jsString(html, "addrVerif_inUse", "False"),
    addrVerifReturnZip4: jsString(html, "addrVerif_ReturnZip4", "False"),
    addrVerifAllowInvalid: jsString(html, "addrVerif_AllowInvalid", "False"),
    restrictVehicleEncroachmentOnline: jsString(html, "restrictVehicleEncroachmentOnline", "0"),
    autoInsertPTime: jsString(html, "autoInsert_PTime"),
    rootPublicDomainAddress: jsString(
      html,
      "rootPublicDomainAddress",
      `${session.cfg.portalBaseUrl}/`,
    ),
    isNewOrder: jsString(html, "isNewOrder"),
    callerName: hiddenValue(html, "UserName", session.cfg.caller ?? controlPrefs.Data?.[0]?.Caller ?? ""),
    prefs: controlPrefs.Data?.[0] ?? {},
    packagePrefs,
  };
}

async function getOnlineAccessData(
  session: PortalSession,
  endpoint: string,
): Promise<PortalListItem[]> {
  const data = await portalJson<PortalListResponse>(
    session,
    `/ClientPortal/ClientPortal/api/onlineaccess/${endpoint}`,
  );
  return Array.isArray(data.Data) ? data.Data : [];
}

function listTextByValue(list: PortalListItem[], id: number): string | undefined {
  const found = list.find((item) => Number(item.Value) === id);
  return found?.Text;
}

// --- Date/time validation ---------------------------------------------------

type PortalTimes = {
  PickupTargetFrom: string;
  PickupTargetTo: string;
  DeliveryTargetFrom: string;
  DeliveryTargetTo: string;
  DeviceTime: string;
  DeviceTimeZone: string;
  ServiceAvailable?: boolean;
  AnyDateTimeForcedChange?: boolean;
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function deviceTime(): string {
  const d = new Date();
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${d.getFullYear()} ${pad2(
    d.getHours(),
  )}:${pad2(d.getMinutes())}`;
}

function deviceTimeZone(): string {
  return process.env.AXIS_DEVICE_TIMEZONE || "COT";
}

function formatPortalDateTime(value: string | Date): string {
  if (typeof value === "string" && /\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}\s+[AP]M/i.test(value)) {
    return value;
  }

  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const hour = d.getHours();
  const hour12 = hour % 12 || 12;
  const ampm = hour >= 12 ? "PM" : "AM";
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${d.getFullYear()} ${pad2(
    hour12,
  )}:${pad2(d.getMinutes())} ${ampm}`;
}

function defaultPortalTimes(): PortalTimes {
  const now = Date.now();
  return {
    PickupTargetFrom: formatPortalDateTime(new Date(now + 10 * 60_000)),
    PickupTargetTo: formatPortalDateTime(new Date(now + 40 * 60_000)),
    DeliveryTargetFrom: formatPortalDateTime(new Date(now + 40 * 60_000)),
    DeliveryTargetTo: formatPortalDateTime(new Date(now + 120 * 60_000)),
    DeviceTime: deviceTime(),
    DeviceTimeZone: deviceTimeZone(),
  };
}

async function validateTimes(
  session: PortalSession,
  ctx: NewOrderContext,
  order: SubmitOrderV4Request,
  current?: Partial<PortalTimes>,
  pageInit = true,
): Promise<PortalTimes> {
  const seed = {
    ...defaultPortalTimes(),
    ...current,
  };
  const data = {
    MySystemVariables: {
      ClientID: ctx.clientId,
      This_Service: order.ServiceId,
      ServiceID: order.ServiceId,
      RoundTrip: "N",
      PickupTargetFrom: seed.PickupTargetFrom,
      PickupTargetTo: seed.PickupTargetTo,
      DeliveryTargetFrom: seed.DeliveryTargetFrom,
      DeliveryTargetTo: seed.DeliveryTargetTo,
      AutoInsert_PTime: ctx.autoInsertPTime,
      MyPaddedTimeStamp: ctx.myPaddedTimestamp,
      DeviceTime: deviceTime(),
      PZip: order.PZip ?? "",
      DZip: order.DZip ?? "",
      DeviceTimeZone: deviceTimeZone(),
    },
  };

  const response = await postPortalJson<{ MySystemVariables?: Partial<PortalTimes> }>(
    session,
    `/ClientPortal/ClientPortal/api/newOrderOnline/ValidateTimesByServiceProp?_p_ServiceIDChanged=false&_p_PageInit=${pageInit ? "true" : "false"}`,
    data,
  );
  const vars = response.MySystemVariables ?? {};

  if (vars.ServiceAvailable === false) {
    throw new AxisError("The selected Axis service is unavailable for the target date/time.");
  }

  return {
    PickupTargetFrom: formatPortalDateTime(vars.PickupTargetFrom || seed.PickupTargetFrom),
    PickupTargetTo: formatPortalDateTime(vars.PickupTargetTo || seed.PickupTargetTo),
    DeliveryTargetFrom: formatPortalDateTime(vars.DeliveryTargetFrom || seed.DeliveryTargetFrom),
    DeliveryTargetTo: formatPortalDateTime(vars.DeliveryTargetTo || seed.DeliveryTargetTo),
    DeviceTime: vars.DeviceTime ?? deviceTime(),
    DeviceTimeZone: vars.DeviceTimeZone ?? deviceTimeZone(),
    ServiceAvailable: vars.ServiceAvailable,
    AnyDateTimeForcedChange: vars.AnyDateTimeForcedChange,
  };
}

// --- Payload building -------------------------------------------------------

type PortalOrderPayload = {
  OrderTrackingId?: string;
  Require3DS?: boolean;
  MySystemVariables: Record<string, unknown>;
};

function cleanString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function firstPackage(order: SubmitOrderV4Request, ctx: NewOrderContext): OrderPackageItemV4 | null {
  const item = order.OrderPackageItems?.[0];
  if (!item) return null;
  const packageId =
    item.PackageId > 0
      ? item.PackageId
      : ctx.packagePrefs.OE_DefaultPackageID && ctx.packagePrefs.OE_DefaultPackageID > 0
        ? ctx.packagePrefs.OE_DefaultPackageID
        : 0;
  if (!packageId) return null;
  return { ...item, PackageId: packageId };
}

function packageCount(item: OrderPackageItemV4 | null): number {
  if (!item) return 0;
  const count = Math.max(1, Math.round(Number(item.Count) || 1));
  return Number.isFinite(count) ? count : 1;
}

function packageTotalWeight(item: OrderPackageItemV4 | null): number {
  return item?.Weight && Number.isFinite(item.Weight) ? item.Weight : 0;
}

function buildPortalOrderPayload(
  order: SubmitOrderV4Request,
  ctx: NewOrderContext,
  times: PortalTimes,
  names: { serviceName?: string; vehicleName?: string },
): PortalOrderPayload {
  const pkg = firstPackage(order, ctx);
  const count = packageCount(pkg);
  const totalWeight = packageTotalWeight(pkg);
  const caller = order.Caller ?? ctx.prefs.Caller ?? ctx.callerName;
  const email = order.Email ?? ctx.prefs.Email ?? "";
  const phone = order.Phone ?? ctx.prefs.Phone ?? "";
  const department = order.Department ?? ctx.prefs.Department ?? "";

  return {
    MySystemVariables: {
      Label_TopBar_OrderTrackingID: ctx.orderTrackingId,
      UserID: ctx.userId,
      ClientID: ctx.clientId,
      _Name: cleanString(caller),
      Phone: cleanString(phone),
      _Department: cleanString(department),
      Email: cleanString(email),
      SpecInstr: cleanString(order.SpecInstr),
      AttachedInventoryList: null,
      Txt_InventoryLockedItemsCount: "0",

      PCoName: cleanString(order.PCoName),
      PContact: cleanString(order.PContact),
      PStreet: cleanString(order.PStreet),
      PStreet2: cleanString(order.PStreet2),
      PCity: cleanString(order.PCity),
      PState: cleanString(order.PState),
      PZip: cleanString(order.PZip),
      PPhone: cleanString(order.PPhone),
      PEmail: cleanString(order.PEmail),
      PSpecInstr: cleanString(order.PSpecInstr),

      DCoName: cleanString(order.DCoName),
      DContact: cleanString(order.DContact),
      DStreet: cleanString(order.DStreet),
      DStreet2: cleanString(order.DStreet2),
      DCity: cleanString(order.DCity),
      DState: cleanString(order.DState),
      DZip: cleanString(order.DZip),
      DPhone: cleanString(order.DPhone),
      DEmail: cleanString(order.DEmail),
      DSpecInstr: cleanString(order.DSpecInstr),

      PSortCode: null,
      DSortCode: null,
      PLocRefNo: "",
      DLocRefNo: "",
      This_Service: order.ServiceId,
      ServiceID: order.ServiceId,
      VehicleID: order.VehicleId,
      ServiceName: names.serviceName ?? "",
      VehicleName: names.vehicleName ?? "",
      RoundTrip: "N",
      PickupTargetFrom: times.PickupTargetFrom,
      PickupTargetTo: times.PickupTargetTo,
      DeliveryTargetFrom: times.DeliveryTargetFrom,
      DeliveryTargetTo: times.DeliveryTargetTo,

      sValue: String(order.sValue ?? 0),
      CODCalc: 0,
      CODAmount: "0",
      ObjPackageCount: count,
      sWeight: String(totalWeight),
      RefNo1: cleanString(order.ClientRefNo),
      RefNo2: cleanString(order.ClientRefNo2),
      RefNo3: cleanString(order.ClientRefNo3),
      RefNo4: cleanString(order.ClientRefNo4),
      MyClientRefNo: cleanString(order.ClientRefNo),
      MyClientRefNo2: cleanString(order.ClientRefNo2),
      MyClientRefNo3: cleanString(order.ClientRefNo3),
      MyClientRefNo4: cleanString(order.ClientRefNo4),

      AddrVerif_InUse: ctx.addrVerifInUse,
      RestrictVehicleEncroachmentOnline: ctx.restrictVehicleEncroachmentOnline,
      AutoInsert_PTime: ctx.autoInsertPTime,
      UsePackageItems: ctx.usePackageItems,
      AddrVerif_ReturnZip4: ctx.addrVerifReturnZip4,
      AddrVerif_AllowInvalid: ctx.addrVerifAllowInvalid,
      Department: cleanString(department),
      COD: ctx.cod,
      CODloc: "D",
      ViewAmount: ctx.viewAmount,
      PaymentSelection: "Later",
      PSaveAddress: false,
      DSaveAddress: false,
      PMakeDefault: false,
      DMakeDefault: false,
      MyPAddressID: 0,
      MyDAddressID: 0,
      SaveAllAsPrivateAddress: ctx.saveAllAsPrivateAddress,
      Login: ctx.login,
      RootPublicDomainAddress: ctx.rootPublicDomainAddress,
      IsNewOrder: ctx.isNewOrder,
      ExtrasList: [],
      MyPaddedTimeStamp: ctx.myPaddedTimestamp,
      CallerName: cleanString(caller),
      AccountStatusOk: false,
      TerminalID: ctx.terminalId,
      AccountNo: order.AccountNo || ctx.accountNo,
      IsContinuation: 0,
      RouteID: 0,
      Pkgs: pkg ? [{ PackageID: pkg.PackageId, Package: "", Count: count }] : [],
      Packages: [],
      StopOffs: [],
      GuestStatus: "0",
      CurrencyPreDisplay: "",
      DeviceTime: times.DeviceTime,
      DeviceTimeZone: times.DeviceTimeZone,

      // Auto notification fields. Keep them explicit because the portal model
      // treats omitted booleans differently from false in some builds.
      AutoNotify_Sender_OnlineUser: "",
      AutoNotify_Sender_Email: "",
      AutoNotify_Pickup_Email: "",
      AutoNotify_Recipient_Email: "",
      AutoNotify_Sender_SMS: "",
      AutoNotify_Pickup_SMS: "",
      AutoNotify_Recipient_SMS: "",
      ...autoNotifyFalseFields(),
    },
  };
}

function autoNotifyFalseFields(): Record<string, false> {
  const fields = [
    "AutoNotify_Push_Caller_OnSubmittal",
    "AutoNotify_Push_Caller_OnPickup",
    "AutoNotify_Push_Caller_OnPOD",
    "AutoNotify_Push_Caller_OnNextStopPickup",
    "AutoNotify_Push_Caller_OnNextStopDelivery",
    "AutoNotify_Push_Caller_OnDriverAssigned",
    "AutoNotify_Push_Caller_OnPickupProximityReached",
    "AutoNotify_Push_Caller_OnDeliveryProximityReached",
    "AutoNotify_Push_Caller_OnPickupETAchange",
    "AutoNotify_Push_Caller_OnDeliveryETAchange",
    "AutoNotify_Sender_OnSubmittal",
    "AutoNotify_Sender_OnPickup",
    "AutoNotify_Sender_OnPOD",
    "AutoNotify_Sender_OnNextStopPickup",
    "AutoNotify_Sender_OnNextStopDelivery",
    "AutoNotify_Email_Caller_OnDriverAssigned",
    "AutoNotify_Email_Caller_OnPickupProximityReached",
    "AutoNotify_Email_Caller_OnDeliveryProximityReached",
    "AutoNotify_Email_Caller_OnPickupETAchange",
    "AutoNotify_Email_Caller_OnDeliveryETAchange",
    "AutoNotify_Pickup_OnSubmittal",
    "AutoNotify_Pickup_OnPickup",
    "AutoNotify_Pickup_OnPOD",
    "AutoNotify_Pickup_OnNextStopPickup",
    "AutoNotify_Pickup_OnNextStopDelivery",
    "AutoNotify_Email_Pickup_OnDriverAssigned",
    "AutoNotify_Email_Pickup_OnPickupProximityReached",
    "AutoNotify_Email_Pickup_OnDeliveryProximityReached",
    "AutoNotify_Email_Pickup_OnPickupETAchange",
    "AutoNotify_Email_Pickup_OnDeliveryETAchange",
    "AutoNotify_Recipient_OnSubmittal",
    "AutoNotify_Recipient_OnPickup",
    "AutoNotify_Recipient_OnPOD",
    "AutoNotify_Recipient_OnNextStopPickup",
    "AutoNotify_Recipient_OnNextStopDelivery",
    "AutoNotify_Email_Delivery_OnDriverAssigned",
    "AutoNotify_Email_Delivery_OnPickupProximityReached",
    "AutoNotify_Email_Delivery_OnDeliveryProximityReached",
    "AutoNotify_Email_Delivery_OnPickupETAchange",
    "AutoNotify_Email_Delivery_OnDeliveryETAchange",
    "AutoNotify_SMS_Sender_OnSubmittal",
    "AutoNotify_SMS_Sender_OnPickup",
    "AutoNotify_SMS_Sender_OnPOD",
    "AutoNotify_SMS_Sender_OnNextStopPickup",
    "AutoNotify_SMS_Sender_OnNextStopDelivery",
    "AutoNotify_Mobile_Caller_OnDriverAssigned",
    "AutoNotify_Mobile_Caller_OnPickupProximityReached",
    "AutoNotify_Mobile_Caller_OnDeliveryProximityReached",
    "AutoNotify_Mobile_Caller_OnPickupETAchange",
    "AutoNotify_Mobile_Caller_OnDeliveryETAchange",
    "AutoNotify_SMS_Pickup_OnSubmittal",
    "AutoNotify_SMS_Pickup_OnPickup",
    "AutoNotify_SMS_Pickup_OnPOD",
    "AutoNotify_SMS_Pickup_OnNextStopPickup",
    "AutoNotify_SMS_Pickup_OnNextStopDelivery",
    "AutoNotify_Mobile_Pickup_OnDriverAssigned",
    "AutoNotify_Mobile_Pickup_OnPickupProximityReached",
    "AutoNotify_Mobile_Pickup_OnDeliveryProximityReached",
    "AutoNotify_Mobile_Pickup_OnPickupETAchange",
    "AutoNotify_Mobile_Pickup_OnDeliveryETAchange",
    "AutoNotify_SMS_Recipient_OnSubmittal",
    "AutoNotify_SMS_Recipient_OnPickup",
    "AutoNotify_SMS_Recipient_OnPOD",
    "AutoNotify_SMS_Recipient_OnNextStopPickup",
    "AutoNotify_SMS_Recipient_OnNextStopDelivery",
    "AutoNotify_Mobile_Delivery_OnDriverAssigned",
    "AutoNotify_Mobile_Delivery_OnPickupProximityReached",
    "AutoNotify_Mobile_Delivery_OnDeliveryProximityReached",
    "AutoNotify_Mobile_Delivery_OnPickupETAchange",
    "AutoNotify_Mobile_Delivery_OnDeliveryETAchange",
  ];
  return Object.fromEntries(fields.map((field) => [field, false])) as Record<string, false>;
}

async function addPortalPackageItems(
  session: PortalSession,
  orderTrackingId: string,
  item: OrderPackageItemV4 | null,
) {
  if (!item) return;
  const count = packageCount(item);
  const unitWeight = item.Weight && count > 0 ? item.Weight / count : 0;
  const packageStr = [
    item.PackageId,
    count,
    cleanNumber(unitWeight),
    cleanNumber(item.Length),
    cleanNumber(item.Width),
    cleanNumber(item.Height),
  ].join(":");

  await postPortalJson(session, "/ClientPortal/ClientPortal/api/newOrderPackage/addPackageItems", {
    OrderTrackingID: orderTrackingId,
    PackageStr: packageStr,
  });
}

function cleanNumber(value: number | undefined): number {
  return value && Number.isFinite(value) ? Number(value.toFixed(3)) : 0;
}

// --- Portal response handling ----------------------------------------------

type PortalOrderResponse = {
  OrderTrackingId?: string | number | null;
  MySystemVariables?: Record<string, unknown>;
};

function collectTopWarnings(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === "string") return value ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(collectTopWarnings);
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap(collectTopWarnings);
  }
  return [];
}

function assertPortalOrderOk(response: PortalOrderResponse, action: string) {
  const vars = response.MySystemVariables ?? {};
  const critical = vars.CriticalException;
  const activation = vars.ActivateException;
  const warnings = collectTopWarnings(vars.Label_TopWarning);

  if (critical) {
    throw new AxisError(
      `${action} failed: ${
        typeof critical === "string"
          ? critical.split(/\r?\n/)[0]
          : "an exception occurred while saving the order."
      }`,
    );
  }
  if (activation) {
    throw new AxisError(`${action} failed: ${String(activation)}`);
  }
  if (warnings.length) {
    throw new AxisError(`${action} failed: ${warnings.join(" ")}`);
  }
}

// --- Public API calls -------------------------------------------------------

/**
 * Create one or more orders through the Xcelerator ClientPortal session.
 * Returns the portal OrderTrackingID values.
 */
export async function submitOrders(
  orders: SubmitOrderV4Request[],
  cfg: AxisConfig = axisConfigFromEnv(),
): Promise<SubmitOrderResponseV4> {
  const session = await loginToPortal(cfg);
  const services = await getOnlineAccessData(session, "GetOEServices").catch(() => []);
  const vehicles = await getOnlineAccessData(session, "GetVehicles").catch(() => []);
  const created: Array<string | number> = [];

  for (const order of orders) {
    const ctx = await loadNewOrderContext(session);
    const orderWithAccount = {
      ...order,
      AccountNo: order.AccountNo || cfg.accountNo || ctx.accountNo,
    };

    const pkg = firstPackage(orderWithAccount, ctx);
    await addPortalPackageItems(session, ctx.orderTrackingId, pkg);

    const initialTimes = await validateTimes(session, ctx, orderWithAccount, undefined, true);
    const payload = buildPortalOrderPayload(orderWithAccount, ctx, initialTimes, {
      serviceName: listTextByValue(services, orderWithAccount.ServiceId),
      vehicleName: listTextByValue(vehicles, orderWithAccount.VehicleId),
    });

    const review = await postPortalJson<PortalOrderResponse>(
      session,
      "/ClientPortal/ClientPortal/api/newOrderOnline/ValidateServicesVehiclesDates?_p_fromSubmitToReview=true",
      payload,
    );
    assertPortalOrderOk(review, "Axis order validation");
    const reviewedVars = review.MySystemVariables ?? {};
    if (typeof reviewedVars.GrandTotal === "number") {
      payload.MySystemVariables.GrandTotal = reviewedVars.GrandTotal;
    }

    const overLimit = await postPortalJson<string>(
      session,
      "/ClientPortal/ClientPortal/api/newOrderOnline/CheckOverLimit",
      payload,
    );
    if (overLimit) throw new AxisError(`Axis order is over limit: ${overLimit}`);

    const online = await portalJson<{ OnlineIsOpen?: boolean; ReturnString?: string | null }>(
      session,
      "/ClientPortal/ClientPortal/api/newOrderOnline/checkonlineavailable",
      { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: "{}" },
    );
    if (!online.OnlineIsOpen) {
      throw new AxisError(online.ReturnString || "Axis online ordering is currently unavailable.");
    }

    const finalTimes = await validateTimes(session, ctx, orderWithAccount, initialTimes, false);
    payload.MySystemVariables.PickupTargetFrom = finalTimes.PickupTargetFrom;
    payload.MySystemVariables.PickupTargetTo = finalTimes.PickupTargetTo;
    payload.MySystemVariables.DeliveryTargetFrom = finalTimes.DeliveryTargetFrom;
    payload.MySystemVariables.DeliveryTargetTo = finalTimes.DeliveryTargetTo;
    payload.MySystemVariables.DeviceTime = finalTimes.DeviceTime;
    payload.MySystemVariables.DeviceTimeZone = finalTimes.DeviceTimeZone;
    payload.OrderTrackingId = ctx.orderTrackingId;
    payload.Require3DS = false;

    const submitted = await postPortalJson<PortalOrderResponse>(
      session,
      "/ClientPortal/ClientPortal/api/newOrderOnline/SubmitOrder",
      payload,
    );
    assertPortalOrderOk(submitted, "Axis SubmitOrder");

    created.push(submitted.OrderTrackingId ?? ctx.orderTrackingId);
  }

  return { OrdersCreated: created };
}

// --- Reference data (to look up ids needed for an order) --------------------

export async function getServiceTypes(cfg: AxisConfig = axisConfigFromEnv()): Promise<unknown> {
  const session = await loginToPortal(cfg);
  return { Data: await getOnlineAccessData(session, "GetOEServices") };
}

export async function getVehicleTypes(cfg: AxisConfig = axisConfigFromEnv()): Promise<unknown> {
  const session = await loginToPortal(cfg);
  return { Data: await getOnlineAccessData(session, "GetVehicles") };
}

export async function getPackageTypes(cfg: AxisConfig = axisConfigFromEnv()): Promise<unknown> {
  const session = await loginToPortal(cfg);
  return portalJson(session, "/ClientPortal/ClientPortal/api/newOrderPackage/getPackageTypeData");
}

// Cache the resolved ids so a burst of submissions makes the lookup once.
let cachedServiceId: number | undefined;
let cachedVehicleId: number | undefined;

function configuredName(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value.toLowerCase() : undefined;
}

function pickListId(
  list: PortalListItem[],
  wantedName: string | undefined,
  fallback: number | undefined,
): number | undefined {
  if (fallback && fallback > 0) return fallback;
  const usable = list.filter((item) => Number(item.Value) > 0);
  if (!usable.length) return undefined;
  let wanted: PortalListItem | undefined;
  if (wantedName) {
    wanted = usable.find(
      (item) =>
        item.Text?.toLowerCase() === wantedName ||
        item.StrValue?.toLowerCase() === wantedName,
    );
  }
  return Number((wanted ?? usable[0]).Value);
}

/**
 * ServiceId to use for an order: configured AXIS_SERVICE_ID when set, otherwise
 * the portal caller default, otherwise the first available service.
 */
export async function resolveServiceId(cfg: AxisConfig = axisConfigFromEnv()): Promise<number> {
  if (cfg.serviceId !== undefined) return cfg.serviceId;
  if (cachedServiceId !== undefined) return cachedServiceId;

  const session = await loginToPortal(cfg);
  const ctx = await loadNewOrderContext(session);
  const list = await getOnlineAccessData(session, "GetOEServices");
  const id = pickListId(list, configuredName("AXIS_SERVICE_NAME"), ctx.prefs.ServiceID);
  if (!id) throw new AxisError("Axis returned no service types; set AXIS_SERVICE_ID.");
  cachedServiceId = id;
  return id;
}

/**
 * VehicleId to use for an order: configured AXIS_VEHICLE_ID when set, otherwise
 * the portal caller default, otherwise the first available vehicle.
 */
export async function resolveVehicleId(cfg: AxisConfig = axisConfigFromEnv()): Promise<number> {
  if (cfg.vehicleId !== undefined) return cfg.vehicleId;
  if (cachedVehicleId !== undefined) return cachedVehicleId;

  const session = await loginToPortal(cfg);
  const ctx = await loadNewOrderContext(session);
  const list = await getOnlineAccessData(session, "GetVehicles");
  const id = pickListId(list, configuredName("AXIS_VEHICLE_NAME"), ctx.prefs.VehicleID);
  if (!id) throw new AxisError("Axis returned no vehicle types; set AXIS_VEHICLE_ID.");
  cachedVehicleId = id;
  return id;
}
