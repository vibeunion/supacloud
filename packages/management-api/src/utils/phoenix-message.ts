import { isRecord } from "./project-config";

export interface PhoenixMessage {
  join_ref: string | null;
  ref: string | null;
  topic: string;
  event: string;
  payload: Record<string, unknown>;
}

export type PhoenixVersion = "1.0.0" | "2.0.0";
export const MAX_REALTIME_FRAME_BYTES = 1024 * 1024;

export function parsePhoenixMessage(value: unknown): PhoenixMessage | null {
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > MAX_REALTIME_FRAME_BYTES) return null;
    try { const parsed: unknown = JSON.parse(value); value = parsed; } catch { return null; }
  }
  if (Array.isArray(value)) {
    if (value.length !== 5) return null;
    value = { join_ref: value[0], ref: value[1], topic: value[2], event: value[3], payload: value[4] };
  }
  if (!isRecord(value)) return null;
  const { topic, event, payload } = value;
  const joinRef = value.join_ref ?? null;
  const ref = value.ref ?? null;
  if ((joinRef !== null && (typeof joinRef !== "string" || joinRef.length > 128))
    || (ref !== null && (typeof ref !== "string" || ref.length > 128))
    || typeof topic !== "string" || !topic || topic.length > 512
    || typeof event !== "string" || !event || event.length > 128 || !isRecord(payload)) return null;
  return { join_ref: joinRef, ref, topic, event, payload };
}

export function encodePhoenixMessage(message: PhoenixMessage, version: PhoenixVersion): string {
  return JSON.stringify(version === "1.0.0" ? message
    : [message.join_ref, message.ref, message.topic, message.event, message.payload]);
}

export function realtimeBinary(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  return null;
}

export function isPhoenixBroadcastFrame(bytes: Uint8Array, direction: "client" | "server"): boolean {
  if (bytes.byteLength > MAX_REALTIME_FRAME_BYTES) return false;
  const kind = bytes[0];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    if (kind === 3 && direction === "client" || kind === 4 && direction === "server") {
      const header = kind === 3 ? 7 : 5;
      if (bytes.length < header) return false;
      const lengths = kind === 3 ? bytes.subarray(1, 6) : bytes.subarray(1, 4);
      const encoding = bytes[header - 1];
      if (encoding !== 0 && encoding !== 1) return false;
      let offset = header;
      const fields: string[] = [];
      for (const length of lengths) {
        if (offset + length > bytes.length) return false;
        fields.push(decoder.decode(bytes.subarray(offset, offset + length)));
        offset += length;
      }
      const topic = fields[kind === 3 ? 2 : 0];
      const event = fields[kind === 3 ? 3 : 1];
      const metadata = fields[kind === 3 ? 4 : 2];
      if (!topic || !event) return false;
      if (metadata) { const value: unknown = JSON.parse(metadata); if (!isRecord(value)) return false; }
      if (encoding === 1) JSON.parse(decoder.decode(bytes.subarray(offset)));
      return true;
    }
    // Legacy Phoenix binary pushes/broadcasts may carry only the broadcast event.
    if ((kind === 0) || (kind === 2 && direction === "server")) {
      const header = kind === 0 ? 5 : 3;
      if (bytes.length < header) return false;
      let offset = header;
      const fields: string[] = [];
      for (const length of bytes.subarray(1, header)) {
        if (offset + length > bytes.length) return false;
        fields.push(decoder.decode(bytes.subarray(offset, offset + length)));
        offset += length;
      }
      return !!fields.at(-2) && fields.at(-1) === "broadcast";
    }
  } catch { return false; }
  return false;
}
