export async function readBoundedText(
  response: Response, maxBytes: number, signal: AbortSignal,
): Promise<string> {
  const reader = response.body?.getReader();
  const cancel = () => { void reader?.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    const length = response.headers.get("content-length");
    if (!reader || !Number.isSafeInteger(maxBytes) || maxBytes < 1
      || (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > maxBytes))) {
      throw new Error("Invalid response body");
    }
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const text: string[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array) || (size += chunk.value.byteLength) > maxBytes) {
        throw new Error("Invalid response body");
      }
      text.push(decoder.decode(chunk.value, { stream: true }));
    }
    text.push(decoder.decode());
    return text.join("");
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader?.releaseLock();
  }
}
