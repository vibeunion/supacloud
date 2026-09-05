import {
  createElysiaDataProvider,
  type ElysiaListContext,
  type ElysiaResourceAdapter,
} from '@svadmin/elysia';
import type { BaseRecord, ChatMessage, ChatProvider, GetListResult } from '@svadmin/core';

function toRecord(value: object): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) result[key] = item;
  return result;
}

function isBaseRecord(value: unknown): value is BaseRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function providerRecords<TData extends BaseRecord>(records: BaseRecord[]): TData[] {
  // @svadmin/elysia exposes a generic response parser without a decoder
  // parameter. The records have been structurally validated at this boundary.
  return records as unknown as TData[];
}

const getApiUrl = () => {
    if (typeof window === 'undefined') return 'http://localhost:9090'; // SSR
    return window.location.origin;
};

function parseNamedListEnvelope<TData extends BaseRecord>(
  payload: unknown,
  context: ElysiaListContext,
  recordKey: string,
): GetListResult<TData> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`Invalid list response for ${context.resource}. Expected an object containing ${recordKey}.`);
  }

  const response = toRecord(payload);
  const applicationError = typeof response.error === 'string'
    ? response.error
    : typeof response.message === 'string'
      ? response.message
      : undefined;
  if (applicationError) throw new Error(applicationError);

  const records = response[recordKey];
  if (!Array.isArray(records)) {
    throw new Error(`Invalid list response for ${context.resource}. Expected an object containing ${recordKey}.`);
  }
  if (!records.every(isBaseRecord)) {
    throw new Error(`Invalid list response for ${context.resource}. Expected object records.`);
  }

  const metadata = Object.fromEntries(
    Object.entries(response).filter(([key]) => key !== recordKey),
  );
  return {
    ...metadata,
      data: providerRecords<TData>(records),
    total: typeof response.total === 'number' ? response.total : records.length,
  };
}

function namedEnvelopeAdapter(
  match: ElysiaResourceAdapter['match'],
  recordKey: string,
): ElysiaResourceAdapter {
  return {
    match,
    parseListResponse: (payload, context) =>
      parseNamedListEnvelope(payload, context, recordKey),
  };
}

const tableRowsAdapter: ElysiaResourceAdapter = {
  match: /^v1\/projects\/[^/]+\/database\/tables\/[^/]+\/[^/]+\/rows$/,
  parseListResponse: <TData extends BaseRecord>(payload: unknown, context: ElysiaListContext) => {
    const normalized = parseNamedListEnvelope<TData>(payload, context, 'data');
    const identityKey = context.meta?.tableRowIdentityKey;
    if (identityKey === undefined) return normalized;
    if (typeof identityKey !== 'string' || identityKey.length === 0) {
      throw new Error(`Invalid table row identity metadata for ${context.resource}.`);
    }
    if (normalized.data.some((record) => !record || typeof record !== 'object' || Array.isArray(record))) {
      throw new Error(`Invalid table row response for ${context.resource}. Expected object records.`);
    }

    const offset = (context.pagination.current - 1) * context.pagination.pageSize;
    return {
      ...normalized,
      data: normalized.data.map((record, index) => ({
        ...record,
        [identityKey]: `${context.resource}:${offset + index}`,
      })),
    };
  },
};

const resourceAdapters: readonly ElysiaResourceAdapter[] = [
  tableRowsAdapter,
  namedEnvelopeAdapter(
    (resource) => resource === 'auth/users' || resource.endsWith('/auth/users'),
    'users',
  ),
  namedEnvelopeAdapter(
    (resource) => resource === 'frontend/deployments' || resource.endsWith('/frontend/deployments'),
    'deployments',
  ),
  namedEnvelopeAdapter(
    (resource) => resource.includes('/functions/') && resource.endsWith('/logs'),
    'logs',
  ),
];

export const dataProvider = createElysiaDataProvider({
  apiUrl: getApiUrl(),
  withCredentials: true,
  resourceAdapters,
});

// Implementation of ChatProvider using Fetch API + SSE for streaming
export const chatProvider: ChatProvider = {
  async *sendMessage(messages: ChatMessage[], options?: { signal?: AbortSignal }): AsyncGenerator<string, void, unknown> {
    try {
      // Direct integration with an OpenAI-compatible /v1/chat/completions endpoint
      // You can point this to your actual locally run proxy/LLM backend
      const res = await fetch(`${getApiUrl()}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini', // Update dynamically if needed
          messages: messages.map(m => ({ role: m.role, content: m.parts?.map(p => ("text" in p ? p.text : "")).join("") ?? "" })),
          stream: true
        }),
        signal: options?.signal,
        credentials: 'include'
      });

      if (!res.ok) throw new Error('Chat API returned an error: ' + res.statusText);
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        const fallback: unknown = await res.json().catch(() => null);
        const fallbackRecord = fallback !== null && typeof fallback === "object" && !Array.isArray(fallback)
          ? toRecord(fallback)
          : {};
        const choices = isUnknownArray(fallbackRecord.choices) ? fallbackRecord.choices : [];
        const firstChoice = choices[0];
        const choiceRecord = firstChoice !== null && typeof firstChoice === "object" && !Array.isArray(firstChoice)
          ? toRecord(firstChoice)
          : {};
        const message = choiceRecord.message;
        const messageRecord = message !== null && typeof message === "object" && !Array.isArray(message)
          ? toRecord(message)
          : {};
        const content = typeof messageRecord.content === "string" ? messageRecord.content : undefined;
        if (content) {
          yield content;
          return;
        }
        throw new Error('No readable stream');
      }

      let buffered: string = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split('\n');
        buffered = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:') || trimmed === 'data: [DONE]') continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const data: unknown = JSON.parse(payload);
            const dataRecord = data !== null && typeof data === "object" && !Array.isArray(data)
              ? toRecord(data)
              : {};
            const dataChoices = isUnknownArray(dataRecord.choices) ? dataRecord.choices : [];
            const delta = dataChoices[0];
            const deltaRecord = delta !== null && typeof delta === "object" && !Array.isArray(delta)
              ? toRecord(delta)
              : {};
            const contentRecord = deltaRecord.delta;
            const content = contentRecord !== null && typeof contentRecord === "object" && !Array.isArray(contentRecord)
              ? toRecord(contentRecord).content
              : undefined;
            if (typeof content === "string") {
              yield content;
            }
          } catch {
            // Ignore malformed stream fragments.
          }
        }
      }

      buffered += decoder.decode();
      const tail = buffered.trim();
      if (tail.startsWith('data:') && tail !== 'data: [DONE]') {
        const payload = tail.slice(5).trim();
        if (payload && payload !== '[DONE]') {
            try {
              const data: unknown = JSON.parse(payload);
              const dataRecord = data !== null && typeof data === "object" && !Array.isArray(data)
                ? toRecord(data)
                : {};
              const dataChoices = isUnknownArray(dataRecord.choices) ? dataRecord.choices : [];
              const delta = dataChoices[0];
              const deltaRecord = delta !== null && typeof delta === "object" && !Array.isArray(delta)
                ? toRecord(delta)
                : {};
              const contentRecord = deltaRecord.delta;
              const content = contentRecord !== null && typeof contentRecord === "object" && !Array.isArray(contentRecord)
                ? toRecord(contentRecord).content
                : undefined;
              if (typeof content === "string") {
                yield content;
              }
            } catch {
              // Ignore malformed tail payload.
            }
        }
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') return;
      const message = error instanceof Error ? error.message : String(error);
      yield `\n\n*(Error: ${message})*`;
    }
  }
};
