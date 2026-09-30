import { open } from "node:fs/promises";
import { EnvironmentBindingError, parseEnvironmentBindings, type EnvironmentBindingsDocument } from "./environment-bindings";

/** Bound actual bytes before decoding/parsing, including files growing during a read. */
export async function readEnvironmentBindingsFile(file: string): Promise<EnvironmentBindingsDocument> {
  try {
    const handle = await open(file, "r");
    try {
      if (!(await handle.stat()).isFile()) throw new EnvironmentBindingError("ENVIRONMENT_BINDINGS_INVALID");
      const limit = 4 * 1024 * 1024;
      const buffer = Buffer.alloc(limit + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > limit) throw new EnvironmentBindingError("ENVIRONMENT_BINDINGS_TOO_LARGE");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
      return parseEnvironmentBindings(JSON.parse(text));
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof EnvironmentBindingError) throw error;
    throw new EnvironmentBindingError("ENVIRONMENT_BINDINGS_INVALID");
  }
}
