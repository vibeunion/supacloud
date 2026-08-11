import { createHash } from "node:crypto";

export function stableStringify(jsonValue: unknown): string {
  if (jsonValue === null || typeof jsonValue !== "object") return JSON.stringify(jsonValue);
  if (Array.isArray(jsonValue)) return `[${jsonValue.map(stableStringify).join(",")}]`;

  const record = jsonValue as Record<string, unknown>;
  const fields = Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(record[key])}`
  );
  return `{${fields.join(",")}}`;
}

export function stableSha256(jsonValue: unknown): string {
  return createHash("sha256").update(stableStringify(jsonValue)).digest("hex");
}
