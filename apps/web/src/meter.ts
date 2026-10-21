// Data meter (ADR 0018). Every app request goes through meteredFetch, so auth, sync, and the
// history and media calls that land later all count. The browser does not expose raw socket
// bytes, so this counts what is measurable: the request line, every header we set, the host
// and content length the network stack adds, and the response status line, headers and body.
// A compressed body uses Content-Length, which is the bytes actually downloaded.
import { monthOf } from "./month.ts";
import { getMeter, setMeter, type StoredMeter } from "./store.ts";

/** The two scopes the meter keeps: the tab session and the local calendar month. */
export interface MeterStorage {
  readMonth(): Promise<StoredMeter | null>;
  writeMonth(row: StoredMeter): Promise<void>;
  readSession(): number;
  writeSession(bytes: number): void;
}

export interface MeterTotals {
  /** Bytes this tab session, across reloads. */
  sessionBytes: number;
  /** Bytes in the device's current calendar month. */
  monthBytes: number;
}

export interface MeterState extends MeterTotals {
  /** The local month the total belongs to, `YYYY-MM`. */
  monthKey: string;
}

type MeterListener = (totals: MeterTotals) => void;
type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const textEncoder = new TextEncoder();

function utf8Bytes(text: string): number {
  return textEncoder.encode(text).byteLength;
}

function headerWireBytes(headers: Headers): number {
  let total = 0;
  for (const [name, value] of headers) total += utf8Bytes(`${name}: ${value}\r\n`);
  return total;
}

/** Human units for the meter. Kept small and deterministic; tests pin the boundaries. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 ? String(Math.round(value)) : value.toFixed(1);
  return `${rounded} ${units[unit] ?? "TB"}`;
}

export interface RequestFacts {
  method: string;
  url: string;
  headers: Headers;
  bodyBytes: number;
}

/**
 * Bytes a request costs on an HTTP/1.1 link: request line, headers, blank line and body.
 * Header names are counted as the browser sends them (lowercase from the Headers object);
 * casing changes no byte count. `Host` and `Content-Length` are implicit headers we add back
 * because fetch sends them without exposing them.
 */
export function requestWireBytes(facts: RequestFacts): number {
  const url = new URL(facts.url);
  const requestLine = utf8Bytes(`${facts.method} ${url.pathname}${url.search} HTTP/1.1\r\n`);
  const headers = new Headers(facts.headers);
  if (!headers.has("host")) headers.set("host", url.host);
  const bodyMethod = facts.method === "POST" || facts.method === "PUT" || facts.method === "PATCH";
  if ((facts.bodyBytes > 0 || bodyMethod) && !headers.has("content-length") && !headers.has("transfer-encoding")) {
    headers.set("content-length", String(facts.bodyBytes));
  }
  return requestLine + headerWireBytes(headers) + 2 + facts.bodyBytes;
}

export interface ResponseFacts {
  status: number;
  statusText: string;
  headers: Headers;
  bodyBytes: number;
}

/** Bytes a response costs on an HTTP/1.1 link: status line, headers, blank line and body. */
export function responseWireBytes(facts: ResponseFacts): number {
  return (
    utf8Bytes(`HTTP/1.1 ${facts.status} ${facts.statusText}\r\n`) +
    headerWireBytes(facts.headers) +
    2 +
    facts.bodyBytes
  );
}

/** Exact byte length of the usual BodyInit shapes, without consuming a stream. */
function bodyByteLength(body: BodyInit | null | undefined): number {
  if (body === null || body === undefined) return 0;
  if (typeof body === "string") return utf8Bytes(body);
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.size;
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return utf8Bytes(body.toString());
  // FormData, ReadableStream and other shapes: the length is not knowable without consuming
  // the body. No app request uses one.
  return 0;
}

/** `meteredFetch(request)` has no `init` to inspect, so read the body's clone before sending. */
async function requestBodyByteLength(request: Request): Promise<number> {
  if (request.body === null) return 0;
  try {
    return (await request.clone().arrayBuffer()).byteLength;
  } catch {
    return 0;
  }
}

function declaredLength(headers: Headers): number | null {
  const raw = headers.get("content-length");
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Counts bytes in memory, persists the month, and notifies the UI. Persistence is queued so
 * two fast responses cannot write an older total after a newer one.
 */
export class DataMeter {
  private sessionBytes = 0;
  private monthBytes = 0;
  private month = "";
  private loaded = false;
  private loading: Promise<void> | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<MeterListener>();

  constructor(
    private readonly storage: MeterStorage,
    private readonly now: () => Date = () => new Date(),
    private readonly fetchImpl: FetchImplementation = (input, init) => fetch(input, init),
  ) {}

  totals(): MeterState {
    return { sessionBytes: this.sessionBytes, monthBytes: this.monthBytes, monthKey: this.month };
  }

  /** The listener is called once immediately with the current totals, then after each change. */
  subscribe(listener: MeterListener): () => void {
    this.listeners.add(listener);
    listener(this.totals());
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Reads the month from storage and rolls it if the calendar has moved on. */
  async load(): Promise<void> {
    await this.ensureLoaded();
    this.roll();
  }

  /** Resolves after queued month writes have landed. Tests use it; the app never waits. */
  async flush(): Promise<void> {
    await this.ensureLoaded();
    await this.writeChain;
  }

  /**
   * Sends a request and counts both directions. A failed request still costs the bytes that
   * left the device, so those are recorded before the response arrives.
   */
  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    await this.ensureLoaded();
    const request = new Request(input, init);
    const bodyBytes = init?.body === undefined ? await requestBodyByteLength(request) : bodyByteLength(init.body);
    this.count(
      requestWireBytes({
        method: request.method,
        url: request.url,
        headers: request.headers,
        bodyBytes,
      }),
    );

    const response = await this.fetchImpl(request);
    try {
      this.count(await this.responseBytes(response));
    } catch {
      // A meter that cannot read a header must not turn a good response into a failure.
    }
    return response;
  }

  private async responseBytes(response: Response): Promise<number> {
    // A bodyless response can still carry the length its body would have had (HEAD, 204, 304).
    // Counting that would bill bytes the radio never received.
    const declared = response.body === null ? null : declaredLength(response.headers);
    if (declared !== null) {
      return responseWireBytes({
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        bodyBytes: declared,
      });
    }
    // No Content-Length: count what the app receives. For an identity body that is the wire
    // size. For a compressed chunked body it over-counts, which is safer than under-counting.
    let bodyBytes = 0;
    try {
      bodyBytes = (await response.clone().arrayBuffer()).byteLength;
    } catch {
      bodyBytes = 0;
    }
    return responseWireBytes({
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      bodyBytes,
    });
  }

  private ensureLoaded(): Promise<void> {
    this.loading ??= this.open();
    return this.loading;
  }

  private async open(): Promise<void> {
    this.month = monthOf(this.now());
    try {
      this.sessionBytes = this.storage.readSession();
    } catch {
      this.sessionBytes = 0;
    }
    let stored: StoredMeter | null = null;
    try {
      stored = await this.storage.readMonth();
    } catch {
      // Private mode or a corrupt DB: the in-memory meter still works, it just cannot persist.
    }
    if (stored !== null && stored.month === this.month) {
      this.monthBytes = stored.bytes;
    } else {
      this.monthBytes = 0;
      this.queueWrite();
    }
    this.loaded = true;
    this.emit();
  }

  private roll(): void {
    if (!this.loaded) return;
    const month = monthOf(this.now());
    if (month === this.month) return;
    this.month = month;
    this.monthBytes = 0;
    this.emit();
    this.queueWrite();
  }

  private count(bytes: number): void {
    const value = Math.round(bytes);
    if (!Number.isFinite(value) || value <= 0) return;
    this.sessionBytes += value;
    try {
      this.storage.writeSession(this.sessionBytes);
    } catch {
      // Session persistence is a convenience; counting in memory must still work.
    }
    this.roll();
    this.monthBytes += value;
    this.emit();
    this.queueWrite();
  }

  private emit(): void {
    const totals = this.totals();
    for (const listener of this.listeners) listener(totals);
  }

  private queueWrite(): void {
    const row: StoredMeter = { month: this.month, bytes: this.monthBytes };
    this.writeChain = this.writeChain
      .then(() => this.storage.writeMonth(row))
      .catch(() => {
        // A meter write must never break a request or a render.
      });
  }
}

const SESSION_KEY = "brr-meter-session";

/** SessionStorage is per tab and survives reloads; month storage is shared IndexedDB. */
function readSessionBytes(): number {
  if (typeof sessionStorage === "undefined") return 0;
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    const value = raw === null ? 0 : Number(raw);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

function writeSessionBytes(bytes: number): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(SESSION_KEY, String(bytes));
  } catch {
    // Private mode or quota: the in-memory session counter is still correct.
  }
}

const browserStorage: MeterStorage = {
  readMonth: getMeter,
  writeMonth: setMeter,
  readSession: readSessionBytes,
  writeSession: writeSessionBytes,
};

/** The one meter the app uses. Tests construct their own with in-memory storage. */
export const meter = new DataMeter(browserStorage);

export function meteredFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return meter.fetch(input, init);
}
