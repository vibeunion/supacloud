import type { FileHandle } from "node:fs/promises";

/** Read only the already-validated descriptor range, plus one overflow byte. */
export async function readBoundedCutoverFile(
  handle: Pick<FileHandle, "read">,
  expectedSize: bigint,
  maximum: number,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maximum) || maximum < 0
    || expectedSize < 0n || expectedSize > BigInt(maximum)) {
    throw new Error("Snapshot file exceeds limits");
  }
  const size = Number(expectedSize);
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(bytes, offset, Math.min(64 * 1024, size - offset), offset);
    if (bytesRead === 0) throw new Error("Snapshot file changed");
    offset += bytesRead;
  }
  const overflow = Buffer.allocUnsafe(1);
  if ((await handle.read(overflow, 0, 1, size)).bytesRead !== 0) {
    throw new Error("Snapshot file changed");
  }
  return bytes;
}
