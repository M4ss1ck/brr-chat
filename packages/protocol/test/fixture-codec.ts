// Shared by the freeze script and the fixture test: pick a decoder by fixture name,
// and turn decoded values into stable JSON (bytes become {"$hex": "..."}).
import { decodeHistoryRequest, decodeHistoryResponse, decodeSyncRequest, decodeSyncResponse } from "../src/index.ts";

export function decodeFixture(name: string, bytes: Uint8Array): unknown {
  if (name.startsWith("sync-request")) return decodeSyncRequest(bytes);
  if (name.startsWith("sync-response")) return decodeSyncResponse(bytes);
  if (name.startsWith("history-request")) return decodeHistoryRequest(bytes);
  if (name.startsWith("history-response")) return decodeHistoryResponse(bytes);
  throw new Error(`no decoder for fixture ${name}`);
}

export function toJson(v: unknown): unknown {
  if (v instanceof Uint8Array) return { $hex: Buffer.from(v).toString("hex") };
  if (Array.isArray(v)) return v.map(toJson);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toJson(x)]));
  return v;
}
