export type JsonObject = Record<string, unknown>;

export function isJsonObject(input: unknown): input is JsonObject {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}

export function unwrapAuthApiObject(payload: unknown): JsonObject {
  if (!isJsonObject(payload)) return {};
  return isJsonObject(payload.data) ? payload.data : payload;
}

export function authApiResponseMessage(payload: unknown, fallback: string): string {
  const responseBody = unwrapAuthApiObject(payload);
  if (typeof responseBody.message === "string" && responseBody.message.trim()) return responseBody.message;
  if (typeof responseBody.error === "string" && responseBody.error.trim()) return responseBody.error;
  if (isJsonObject(responseBody.error) && typeof responseBody.error.message === "string") {
    return responseBody.error.message;
  }
  return fallback;
}

export async function readAuthApiPayload(response: Response): Promise<unknown> {
  const responseBody = await response.text();
  if (!responseBody) return {};
  try {
    return JSON.parse(responseBody);
  } catch {
    return { message: responseBody };
  }
}
