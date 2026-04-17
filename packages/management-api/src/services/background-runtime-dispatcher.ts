interface BackgroundDispatchInput {
  projectRef: string;
  functionSlug: string;
  request: Request;
  onLog?: (entry: {
    timestamp: string;
    stream: "stdout" | "stderr";
    level: string;
    message: string;
  }) => void;
}

interface BackgroundDispatchResult {
  status: number;
  headers: Record<string, string | string[]>;
  bodyText: string;
  logs: Array<{
    timestamp: string;
    stream: "stdout" | "stderr";
    level: string;
    message: string;
  }>;
}

function headersToObject(headers: Headers): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === "set-cookie") return;
    out[key] = value;
  });
  const cookies = (headers as any).getSetCookie?.();
  if (cookies && cookies.length > 0) out["set-cookie"] = cookies;
  return out;
}

export async function dispatchBackgroundFunction(
  input: BackgroundDispatchInput,
): Promise<BackgroundDispatchResult> {
  const response = await fetch(input.request);
  const payload = await response.json().catch(async () => ({
    status: response.status,
    headers: headersToObject(response.headers),
    bodyText: await response.text(),
    logs: [],
  }));

  const logs = Array.isArray(payload.logs) ? payload.logs : [];
  if (input.onLog) {
    for (const entry of logs) {
      input.onLog(entry);
    }
  }

  return {
    status: typeof payload.status === "number" ? payload.status : response.status,
    headers: payload.headers || headersToObject(response.headers),
    bodyText: typeof payload.bodyText === "string" ? payload.bodyText : "",
    logs,
  };
}
