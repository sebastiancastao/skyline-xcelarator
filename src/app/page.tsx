"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type MappedField = { label: string; value: string | null };
type DocumentMapping = {
  type: string;
  label: string;
  confidence: number;
  fields: MappedField[];
};

type FileResult =
  | {
      ok: true;
      fileName: string;
      fileSize: number;
      totalPages: number;
      text: string;
      info: Record<string, unknown>;
      ocrUsed: boolean;
      mapping: DocumentMapping | null;
    }
  | {
      ok: false;
      fileName: string;
      fileSize: number;
      error: string;
    };

type PickedFile = { file: File; path: string };

// Document types that can be mapped onto the Air Waybill form. Keep in sync
// with mappingToAwbValues in lib/awb-fill.
const AWB_FILLABLE_TYPES = new Set(["dhl-iac", "dhl-sameday-ticket"]);

type FillableResult = Extract<FileResult, { ok: true }> & {
  mapping: DocumentMapping;
};

function canFillAwb(result: FileResult): result is FillableResult {
  return Boolean(
    result.ok && result.mapping && AWB_FILLABLE_TYPES.has(result.mapping.type),
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// A display path may be a nested path like "reports/q1/file.pdf"; turn it into a
// safe ".txt" download name from just the final segment.
function downloadName(path: string) {
  const leaf = path.split("/").pop() ?? path;
  return leaf.replace(/\.pdf$/i, "") + ".txt";
}

type Carrier = "southwest" | "delta";
// Drop-zone workflow. Southwest/Delta are air-tender (fill AWB/IAC, redirect
// delivery to the airline counter); "normal" is a plain pickup -> delivery
// order with the ticket's actual addresses and no AWB/IAC; "ait" submits an AIT
// Worldwide Logistics Pickup Order as-is (no AWB/IAC).
type Workflow = Carrier | "normal" | "ait";

// Download name for the filled PDF, by carrier workflow. Southwest yields the
// merged Air Waybill + IAC; Delta yields the IAC only. For Southwest we name the
// file after the job's reference number when one was extracted, falling back to
// the uploaded file's name when it's missing.
function filledFileName(path: string, mapping: DocumentMapping, carrier: Carrier) {
  const leaf = path.split("/").pop() ?? path;
  const stem = leaf.replace(/\.pdf$/i, "");

  let suffix = "_AirWaybill";
  if (mapping.type === "dhl-sameday-ticket") {
    suffix = carrier === "delta" ? "_IAC" : "_AirWaybill_IAC";
  }

  let base = stem;
  if (carrier === "southwest") {
    const ref = mapping.fields.find((f) => f.label === "Reference Number")?.value;
    // Strip anything unsafe for a filename; an empty result falls back to stem.
    const safeRef = ref ? ref.replace(/[^A-Za-z0-9._-]+/g, "") : "";
    if (safeRef) base = safeRef;
  }

  return base + suffix + ".pdf";
}

// Request the filled PDF for a mapping. Southwest returns the merged Air Waybill
// + IAC packet; Delta returns the IAC certification only.
async function fetchFilled(
  mapping: DocumentMapping,
  carrier: Carrier,
): Promise<Blob> {
  const res = await fetch("/api/fill-awb", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mapping, carrier }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? "Failed to generate the document.");
  }
  return res.blob();
}

// Generate and download the filled PDF for one parsed result.
async function downloadFilledDocs(
  result: FillableResult,
  carrier: Carrier = "southwest",
) {
  const blob = await fetchFilled(result.mapping, carrier);
  downloadBlob(blob, filledFileName(result.fileName, result.mapping, carrier));
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Document types that can be submitted to the Skyline Axis API as a new
// shipment/order. Keep in sync with AXIS_SUBMITTABLE_TYPES in lib/axis-map.
const AXIS_SUBMITTABLE_TYPES = new Set([
  "dhl-sameday-ticket",
  "ait-pickup-order",
]);

function canSubmitAxis(result: FileResult): result is FillableResult {
  return Boolean(
    result.ok && result.mapping && AXIS_SUBMITTABLE_TYPES.has(result.mapping.type),
  );
}

type AxisSubmitResult = {
  ok: boolean;
  submitted?: number;
  ordersCreated?: Array<string | number>;
  skipped?: string[];
};

// Axis order workflow: "air-tender" (Southwest/Delta) redirects delivery to the
// airline counter; "normal" keeps the ticket's actual pickup/delivery.
type AxisMode = "air-tender" | "normal";

// Submit parsed mappings to the Axis API as new orders. Resolves with the ids
// of the created orders, or throws with the server's error message.
async function submitMappingsToAxis(
  mappings: DocumentMapping[],
  mode: AxisMode = "air-tender",
): Promise<AxisSubmitResult> {
  const res = await fetch("/api/axis-submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mappings, mode }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "Failed to submit to Axis.");
  return data as AxisSubmitResult;
}

type AxisPreview = {
  dryRun: true;
  endpoint: string;
  orders: unknown[];
  skipped: string[];
  placeholders: string[];
};

// Build (but do not send) the order payload for a mapping, to preview the exact
// JSON that would be POSTed to Axis. No authentication required.
async function previewAxisOrder(
  mapping: DocumentMapping,
  mode: AxisMode = "air-tender",
): Promise<AxisPreview> {
  const res = await fetch("/api/axis-submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mappings: [mapping], dryRun: true, mode }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "Failed to build preview.");
  return data as AxisPreview;
}

// Human-readable summary of a submit response, e.g. "Submitted 2 · orders 1001, 1002".
function axisSummary(data: AxisSubmitResult, fallbackCount: number): string {
  const ids = data.ordersCreated ?? [];
  const count = data.submitted ?? fallbackCount;
  return (
    `Submitted ${count} to Axis` +
    (ids.length ? ` · order${ids.length > 1 ? "s" : ""} ${ids.join(", ")}` : "")
  );
}

function isPdf(file: File, path: string) {
  return file.type === "application/pdf" || path.toLowerCase().endsWith(".pdf");
}

function fromFileList(list: FileList): PickedFile[] {
  // webkitRelativePath is populated for folder (webkitdirectory) selections.
  return Array.from(list).map((file) => ({
    file,
    path: file.webkitRelativePath || file.name,
  }));
}

// --- Recursive folder traversal for drag-and-drop (File System Entry API) ---

function readEntriesBatch(
  reader: FileSystemDirectoryReader,
): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

function getFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function walkEntry(entry: FileSystemEntry, out: PickedFile[]) {
  if (entry.isFile) {
    const file = await getFile(entry as FileSystemFileEntry);
    out.push({ file, path: (entry.fullPath || file.name).replace(/^\//, "") });
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries returns results in batches; keep reading until it's empty.
    let batch: FileSystemEntry[];
    do {
      batch = await readEntriesBatch(reader);
      for (const e of batch) await walkEntry(e, out);
    } while (batch.length > 0);
  }
}

export default function Home() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<FileResult[]>([]);
  // Workflow of the most recent upload, set by which drop zone was used.
  const [workflow, setWorkflow] = useState<Workflow>("southwest");
  // Air-tender workflows (Southwest/Delta) fill AWB/IAC and redirect delivery to
  // the airline counter. "normal" and "ait" don't fill anything; the PDF-fill
  // helpers only accept a Carrier, so map them onto a harmless default (unused,
  // as the fill UI is hidden for those workflows).
  const isAirTender = workflow === "southwest" || workflow === "delta";
  const carrier: Carrier = workflow === "delta" ? "delta" : "southwest";
  const axisMode: AxisMode = isAirTender ? "air-tender" : "normal";

  const handleFiles = useCallback(
    async (picked: PickedFile[], chosen: Workflow) => {
      if (picked.length === 0) return;
      const pdfs = picked.filter(({ file, path }) => isPdf(file, path));
      if (pdfs.length === 0) {
        setResults([]);
        setError("No PDF files found in the selection.");
        return;
      }
      setError(null);
      setResults([]);
      setWorkflow(chosen);
      setLoading(true);
      try {
        const formData = new FormData();
        for (const { file, path } of pdfs) {
          formData.append("file", file);
          formData.append("path", path);
        }
        const res = await fetch("/api/parse", { method: "POST", body: formData });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Something went wrong.");
        setResults(data.results as FileResult[]);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unexpected error.");
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const [downloadingAwbs, setDownloadingAwbs] = useState(false);
  const [awbError, setAwbError] = useState<string | null>(null);

  // Every parsed fillable document can produce one or more filled forms — but
  // only in an air-tender workflow (normal orders don't generate AWB/IAC).
  const awbResults = isAirTender ? results.filter(canFillAwb) : [];

  const downloadAllAwbs = useCallback(async () => {
    setDownloadingAwbs(true);
    setAwbError(null);
    let failures = 0;
    for (const r of results) {
      if (!canFillAwb(r)) continue;
      try {
        await downloadFilledDocs(r, carrier);
      } catch {
        failures++;
      }
    }
    if (failures > 0) {
      setAwbError(`${failures} document${failures > 1 ? "s" : ""} failed to generate.`);
    }
    setDownloadingAwbs(false);
  }, [results, carrier]);

  const [submittingAxis, setSubmittingAxis] = useState(false);
  const [axisMsg, setAxisMsg] = useState<string | null>(null);
  const [axisError, setAxisError] = useState<string | null>(null);
  // Bumping this re-fetches the "today's orders" list (after each submission).
  const [ordersRefreshKey, setOrdersRefreshKey] = useState(0);
  const refreshOrders = useCallback(() => setOrdersRefreshKey((k) => k + 1), []);

  // Parsed tickets that can be turned into Axis orders.
  const axisResults = results.filter(canSubmitAxis);

  const submitAllToAxis = useCallback(async () => {
    setSubmittingAxis(true);
    setAxisMsg(null);
    setAxisError(null);
    try {
      const mappings = results.filter(canSubmitAxis).map((r) => r.mapping);
      const data = await submitMappingsToAxis(mappings, axisMode);
      setAxisMsg(axisSummary(data, mappings.length));
      refreshOrders();
    } catch (err) {
      setAxisError(err instanceof Error ? err.message : "Failed to submit to Axis.");
    } finally {
      setSubmittingAxis(false);
    }
  }, [results, refreshOrders, axisMode]);

  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-12">
      <header className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">PDF Parser</h1>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          Upload PDFs — or whole folders of them — to extract text and metadata.
          Files are parsed on the server and never stored.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <DropZone
          title="Southwest"
          subtitle="Fills Air Waybill + IAC"
          onFiles={(picked) => handleFiles(picked, "southwest")}
        />
        <DropZone
          title="Delta"
          subtitle="Fills DHL IAC only"
          onFiles={(picked) => handleFiles(picked, "delta")}
        />
        <DropZone
          title="Normal order"
          subtitle="Pickup → delivery as-is (no AWB/IAC)"
          onFiles={(picked) => handleFiles(picked, "normal")}
        />
        <DropZone
          title="AIT"
          subtitle="Submit AIT Pickup Order (no IAC)"
          onFiles={(picked) => handleFiles(picked, "ait")}
        />
      </div>

      {loading && (
        <p className="mt-6 flex items-center gap-2 text-sm text-gray-500">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-blue-600" />
          Parsing PDFs…
        </p>
      )}

      {error && (
        <div className="mt-6 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
          {error}
        </div>
      )}

      {results.length > 0 && (
        <section className="mt-8">
          <div className="mb-4 flex items-center justify-between gap-3">
            <p className="text-sm text-gray-500">
              {okCount} parsed
              {failCount > 0 ? ` · ${failCount} failed` : ""}
              {awbResults.length > 0
                ? ` · ${awbResults.length} fillable · ${
                    carrier === "delta" ? "Delta" : "Southwest"
                  }`
                : ""}
            </p>
            <div className="flex items-center gap-2">
              {awbError && (
                <span className="text-sm text-red-600 dark:text-red-400">
                  {awbError}
                </span>
              )}
              {awbResults.length > 0 && (
                <button
                  onClick={downloadAllAwbs}
                  disabled={downloadingAwbs}
                  className="rounded-md border border-blue-600 px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-60 dark:text-blue-300 dark:hover:bg-blue-950/40"
                >
                  {downloadingAwbs
                    ? "Generating…"
                    : `Download all filled forms (${awbResults.length})`}
                </button>
              )}
              {axisResults.length > 0 && (
                <button
                  onClick={submitAllToAxis}
                  disabled={submittingAxis}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
                >
                  {submittingAxis
                    ? "Submitting…"
                    : `Submit all to Axis (${axisResults.length})`}
                </button>
              )}
            </div>
          </div>
          {(axisMsg || axisError) && (
            <div
              className={`mb-4 rounded-lg border px-4 py-2 text-sm ${
                axisError
                  ? "border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400"
                  : "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400"
              }`}
            >
              {axisError ?? axisMsg}
            </div>
          )}

          <div className="space-y-3">
            {results.map((r, i) => (
              <FileCard
                key={`${r.fileName}-${i}`}
                result={r}
                carrier={carrier}
                airTender={isAirTender}
                axisMode={axisMode}
                onAxisSubmitted={refreshOrders}
              />
            ))}
          </div>
        </section>
      )}

      <TodaysOrders refreshKey={ordersRefreshKey} />
    </main>
  );
}

type TodaysOrder = {
  orderTrackingId: string;
  submittedAt: string;
  clientRefNo?: string;
  clientRefNo2?: string;
  pickup?: string;
  delivery?: string;
  accountNo?: string;
};

// Persistent list of orders this app has submitted to Axis today. Backed by the
// server-side order log (/api/axis-orders), so it survives reloads and restarts.
function TodaysOrders({ refreshKey }: { refreshKey: number }) {
  const [orders, setOrders] = useState<TodaysOrder[]>([]);
  const [day, setDay] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pure fetch — no setState, so it's safe to call from an effect.
  const fetchOrders = useCallback(async () => {
    const res = await fetch("/api/axis-orders");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Failed to load orders.");
    return { orders: (data.orders as TodaysOrder[]) ?? [], day: data.day ?? null };
  }, []);

  // Manual refresh (event handler) — setState here is fine.
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchOrders();
      setOrders(data.orders);
      setDay(data.day);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load orders.");
    } finally {
      setLoading(false);
    }
  }, [fetchOrders]);

  // Initial load and reload on submit. State is only set in async callbacks.
  useEffect(() => {
    let active = true;
    fetchOrders()
      .then((data) => {
        if (!active) return;
        setOrders(data.orders);
        setDay(data.day);
      })
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : "Failed to load orders.");
        }
      });
    return () => {
      active = false;
    };
  }, [fetchOrders, refreshKey]);

  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <section className="mt-12 border-t border-gray-200 pt-8 dark:border-gray-800">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">
          Today&apos;s Axis orders
          <span className="ml-2 text-sm font-normal text-gray-500">
            {day ? `(${day}) · ` : ""}
            {orders.length}
          </span>
        </h2>
        <button
          onClick={load}
          disabled={loading}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-50 disabled:opacity-60 dark:border-gray-700 dark:hover:bg-gray-800"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && (
        <p className="mb-3 text-sm text-red-600 dark:text-red-400">{error}</p>
      )}

      {orders.length === 0 ? (
        <p className="text-sm text-gray-500">
          No orders submitted to Axis today yet. Submitting a parsed ticket adds
          it here.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-800">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500 dark:bg-gray-900">
              <tr>
                <th className="px-3 py-2 font-medium">Order #</th>
                <th className="px-3 py-2 font-medium">Time</th>
                <th className="px-3 py-2 font-medium">Reference</th>
                <th className="px-3 py-2 font-medium">Pickup → Delivery</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
              {orders.map((o, i) => (
                <tr key={`${o.orderTrackingId}-${i}`}>
                  <td className="px-3 py-2 font-medium">{o.orderTrackingId}</td>
                  <td className="px-3 py-2 text-gray-500">{time(o.submittedAt)}</td>
                  <td className="px-3 py-2">
                    {o.clientRefNo || o.clientRefNo2 || "—"}
                  </td>
                  <td className="px-3 py-2 text-gray-500">
                    {[o.pickup, o.delivery].filter(Boolean).join(" → ") || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// A drag-and-drop / browse zone for one carrier workflow. The zone a file is
// dropped into decides how its filled documents are produced.
function DropZone({
  title,
  subtitle,
  onFiles,
}: {
  title: string;
  subtitle: string;
  onFiles: (picked: PickedFile[]) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  // webkitdirectory isn't in React's input typings, so set it on mount.
  useEffect(() => {
    const el = folderInputRef.current;
    if (el) {
      el.setAttribute("webkitdirectory", "");
      el.setAttribute("directory", "");
    }
  }, []);

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      // Collect entries synchronously — the DataTransfer list is cleared once
      // the handler yields to an await.
      const entries: FileSystemEntry[] = [];
      const items = e.dataTransfer.items;
      if (items?.length) {
        for (const item of Array.from(items)) {
          const entry = item.webkitGetAsEntry?.();
          if (entry) entries.push(entry);
        }
      }
      const picked: PickedFile[] = [];
      if (entries.length) {
        for (const entry of entries) await walkEntry(entry, picked);
      } else if (e.dataTransfer.files?.length) {
        for (const file of Array.from(e.dataTransfer.files)) {
          picked.push({ file, path: file.name });
        }
      }
      onFiles(picked);
    },
    [onFiles],
  );

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 text-center transition ${
        dragging
          ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30"
          : "border-gray-300 dark:border-gray-700"
      }`}
    >
      <p className="font-semibold">{title}</p>
      <p className="mt-1 mb-4 text-xs text-gray-500">{subtitle}</p>
      <div className="flex gap-2">
        <button
          onClick={() => fileInputRef.current?.click()}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
        >
          Browse files
        </button>
        <button
          onClick={() => folderInputRef.current?.click()}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          Select folder
        </button>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) onFiles(fromFileList(e.target.files));
          e.target.value = "";
        }}
      />
      <input
        ref={folderInputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) onFiles(fromFileList(e.target.files));
          e.target.value = "";
        }}
      />
    </div>
  );
}

function FileCard({
  result,
  carrier,
  airTender,
  axisMode,
  onAxisSubmitted,
}: {
  result: FileResult;
  carrier: Carrier;
  airTender: boolean;
  axisMode: AxisMode;
  onAxisSubmitted?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [filling, setFilling] = useState(false);
  const [fillError, setFillError] = useState<string | null>(null);
  const [submittingAxis, setSubmittingAxis] = useState(false);
  const [axisMsg, setAxisMsg] = useState<string | null>(null);
  const [axisError, setAxisError] = useState<string | null>(null);

  // Tickets carry a full shipment and can be pushed to Axis as a new order.
  const submittable = canSubmitAxis(result);

  const submitAxis = useCallback(async () => {
    if (!canSubmitAxis(result)) return;
    setSubmittingAxis(true);
    setAxisMsg(null);
    setAxisError(null);
    try {
      const data = await submitMappingsToAxis([result.mapping], axisMode);
      setAxisMsg(axisSummary(data, 1));
      onAxisSubmitted?.();
    } catch (err) {
      setAxisError(err instanceof Error ? err.message : "Unexpected error.");
    } finally {
      setSubmittingAxis(false);
    }
  }, [result, axisMode, onAxisSubmitted]);

  const [axisPreview, setAxisPreview] = useState<string | null>(null);
  const previewAxis = useCallback(async () => {
    if (!canSubmitAxis(result)) return;
    if (axisPreview) {
      setAxisPreview(null); // toggle off
      return;
    }
    setAxisError(null);
    try {
      const data = await previewAxisOrder(result.mapping, axisMode);
      setAxisPreview(JSON.stringify(data.orders, null, 2));
      if (data.placeholders.length) {
        setAxisMsg(
          `Preview only — ${data.placeholders.join(" & ")} shown as 0 until set in .env.local`,
        );
      }
    } catch (err) {
      setAxisError(err instanceof Error ? err.message : "Unexpected error.");
    }
  }, [result, axisPreview, axisMode]);

  // Documents we know how to map onto the Air Waybill form — air-tender only;
  // normal orders don't generate AWB/IAC.
  const fillable = airTender && canFillAwb(result);
  // The carrier (chosen by drop zone) decides the output: Southwest = Air
  // Waybill + IAC, Delta = IAC only. A standalone IAC just fills the Air Waybill.
  const isTicket = result.ok && result.mapping?.type === "dhl-sameday-ticket";
  const fillLabel = !isTicket
    ? "Download filled Air Waybill"
    : carrier === "delta"
      ? "Download filled IAC"
      : "Download filled Air Waybill + IAC";

  const downloadAwb = useCallback(async () => {
    if (!canFillAwb(result)) return;
    setFilling(true);
    setFillError(null);
    try {
      await downloadFilledDocs(result, carrier);
    } catch (err) {
      setFillError(err instanceof Error ? err.message : "Unexpected error.");
    } finally {
      setFilling(false);
    }
  }, [result, carrier]);

  const copyText = useCallback(() => {
    if (!result.ok) return;
    navigator.clipboard.writeText(result.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [result]);

  const downloadText = useCallback(() => {
    if (!result.ok) return;
    const blob = new Blob([result.text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = downloadName(result.fileName);
    a.click();
    URL.revokeObjectURL(url);
  }, [result]);

  if (!result.ok) {
    return (
      <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 dark:border-red-900 dark:bg-red-950/40">
        <div className="flex items-center justify-between gap-3">
          <span className="truncate font-medium">{result.fileName}</span>
          <span className="shrink-0 text-xs text-gray-500">
            {formatBytes(result.fileSize)}
          </span>
        </div>
        <p className="mt-1 text-sm text-red-700 dark:text-red-400">
          {result.error}
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-800">
      <div className="flex items-center gap-2 pr-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex min-w-0 flex-1 items-center justify-between gap-3 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-900"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate font-medium">{result.fileName}</span>
          {result.mapping && (
            <span className="shrink-0 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-950/60 dark:text-blue-300">
              {result.mapping.label}
            </span>
          )}
          {result.ocrUsed && (
            <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">
              OCR
            </span>
          )}
        </span>
        <span className="shrink-0 text-xs text-gray-500">
          {result.totalPages} pg · {formatBytes(result.fileSize)} ·{" "}
          {result.text.length.toLocaleString()} chars
        </span>
        <svg
          className={`h-4 w-4 shrink-0 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
        {fillable && (
          <button
            onClick={downloadAwb}
            disabled={filling}
            className="shrink-0 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {filling ? "Generating…" : fillLabel}
          </button>
        )}
        {submittable && (
          <>
            <button
              onClick={previewAxis}
              className="shrink-0 rounded-md border border-emerald-600 px-3 py-1.5 text-sm font-medium text-emerald-700 hover:bg-emerald-50 dark:text-emerald-300 dark:hover:bg-emerald-950/40"
            >
              {axisPreview ? "Hide preview" : "Preview Axis order"}
            </button>
            <button
              onClick={submitAxis}
              disabled={submittingAxis}
              className="shrink-0 rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
            >
              {submittingAxis ? "Submitting…" : "Submit to Axis"}
            </button>
          </>
        )}
      </div>
      {axisPreview && (
        <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap border-t border-gray-200 bg-gray-50 p-4 text-xs dark:border-gray-800 dark:bg-gray-900">
          {axisPreview}
        </pre>
      )}
      {fillError && (
        <p className="border-t border-gray-200 px-4 py-2 text-sm text-red-600 dark:border-gray-800 dark:text-red-400">
          {fillError}
        </p>
      )}
      {(axisMsg || axisError) && (
        <p
          className={`border-t px-4 py-2 text-sm ${
            axisError
              ? "border-gray-200 text-red-600 dark:border-gray-800 dark:text-red-400"
              : "border-gray-200 text-emerald-600 dark:border-gray-800 dark:text-emerald-400"
          }`}
        >
          {axisError ?? axisMsg}
        </p>
      )}

      {open && (
        <div className="border-t border-gray-200 p-4 dark:border-gray-800">
          {result.mapping && (
            <div className="mb-4">
              <div className="mb-2 flex items-center gap-2">
                <h3 className="text-sm font-semibold">
                  {result.mapping.label}
                </h3>
                <span className="text-xs text-gray-500">
                  {Math.round(result.mapping.confidence * 100)}% match
                </span>
              </div>
              <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-gray-200 bg-gray-200 text-sm sm:grid-cols-2 dark:border-gray-800 dark:bg-gray-800">
                {result.mapping.fields.map((f) => (
                  <div
                    key={f.label}
                    className="bg-white px-3 py-2 dark:bg-gray-950"
                  >
                    <dt className="text-xs text-gray-500">{f.label}</dt>
                    <dd
                      className={
                        f.value
                          ? "font-medium"
                          : "italic text-gray-400 dark:text-gray-600"
                      }
                    >
                      {f.value ?? "—"}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
          <div className="mb-3 flex justify-end gap-2">
            <button
              onClick={copyText}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
            <button
              onClick={downloadText}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
            >
              Download .txt
            </button>
          </div>
          <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm dark:border-gray-800 dark:bg-gray-900">
            {result.text ||
              "(No extractable text — this PDF may be made of scanned images.)"}
          </pre>
        </div>
      )}
    </div>
  );
}
