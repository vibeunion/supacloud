import { expect, test } from "bun:test";
import { appendFile, mkdtemp, open, rm, truncate } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readBoundedCutoverFile } from "../../scripts/lib/frontend-cutover-file";

async function withFile(bytes: Uint8Array, work: (path: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "frontend-cutover-bound-"));
  try {
    const path = join(root, "snapshot");
    await Bun.write(path, bytes);
    await work(path);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test.each([0, 1, 65535, 65536, 65537, 200000])("bounded snapshot reads exact %s-byte content", async size => {
  const expected = Buffer.alloc(size, 0x5a);
  await withFile(expected, async path => {
    const handle = await open(path, "r");
    try { expect(await readBoundedCutoverFile(handle, BigInt(size), size)).toEqual(expected); }
    finally { await handle.close(); }
  });
});

test.each([0, 1, 65536])("growth after %s-byte stat never permits an unbounded read", async original => {
  await withFile(Buffer.alloc(original), async path => {
    const handle = await open(path, "r");
    try {
      await appendFile(path, Buffer.alloc(2 * 1024 * 1024));
      await expect(readBoundedCutoverFile(handle, BigInt(original), original)).rejects.toThrow("Snapshot file changed");
    } finally { await handle.close(); }
  });
});

test.each([1, 65536, 65537])("truncation after %s-byte stat does not return partial bytes", async original => {
  await withFile(Buffer.alloc(original), async path => {
    const handle = await open(path, "r");
    try {
      await truncate(path, original - 1);
      await expect(readBoundedCutoverFile(handle, BigInt(original), original)).rejects.toThrow("Snapshot file changed");
    } finally { await handle.close(); }
  });
});

const invalidLimits: Array<[bigint, number]> = [
  [-1n, 1], [2n, 1], [1n, -1], [1n, 0.5], [1n, Infinity], [1n, Number.MAX_SAFE_INTEGER + 1],
];
test.each(invalidLimits)("rejects invalid expected size %s / limit %s", async (expected, maximum) => {
  await withFile(Buffer.from("x"), async path => {
    const handle = await open(path, "r");
    try { await expect(readBoundedCutoverFile(handle, expected, maximum)).rejects.toThrow("Snapshot file exceeds limits"); }
    finally { await handle.close(); }
  });
});
