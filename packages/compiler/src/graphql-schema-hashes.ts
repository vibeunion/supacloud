import { createHash } from "node:crypto";

/** Preserve byte provenance separately from physical line-ending diagnostics. */
export function graphqlSchemaHashes(content: string): {
  schemaHash: string;
  schemaNormalizedHash: string;
} {
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  return {
    schemaHash: hash(content),
    schemaNormalizedHash: hash(content.replace(/\r\n?/g, "\n")),
  };
}
