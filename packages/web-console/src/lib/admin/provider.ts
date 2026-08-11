import { createElysiaDataProvider } from '@svadmin/elysia';
import type { ChatProvider, ChatMessage } from '@svadmin/core';

const getApiUrl = () => {
    if (typeof window === 'undefined') return 'http://localhost:9090'; // SSR
    return window.location.origin;
};

interface ListEnvelopeAdapter {
    matches: (resource: string) => boolean;
    recordKeys: readonly string[];
}

const defaultListRecordKeys = ["items", "data", "rows"] as const;
const listEnvelopeAdapters: readonly ListEnvelopeAdapter[] = [
    {
        matches: (resource) => resource === "auth/users" || resource.endsWith("/auth/users"),
        recordKeys: ["users"],
    },
    {
        matches: (resource) => resource === "frontend/deployments" || resource.endsWith("/frontend/deployments"),
        recordKeys: ["deployments"],
    },
    {
        matches: (resource) => resource.includes("/functions/") && resource.endsWith("/logs"),
        recordKeys: ["logs"],
    },
];

function listRecordKeysFor(resource: string): readonly string[] {
    const adapter = listEnvelopeAdapters.find((candidate) => candidate.matches(resource));
    return adapter ? [...adapter.recordKeys, ...defaultListRecordKeys] : defaultListRecordKeys;
}

function normalizeListEnvelope(
    response: Record<string, unknown>,
    recordKey: string,
): { data: unknown[]; total: number; [key: string]: unknown } {
    const { [recordKey]: recordValue, ...metadata } = response;
    const records = recordValue as unknown[];
    return {
        ...metadata,
        data: records,
        total: typeof response.total === "number" ? response.total : records.length,
    };
}

export function parseListResponse(payload: unknown, resource: string) {
    if (Array.isArray(payload)) return { data: payload, total: payload.length };
    if (!payload || typeof payload !== "object") throw new Error(`Invalid list response for ${resource}`);

    const response = payload as Record<string, unknown>;
    if (response.error || response.message) {
        const message = typeof response.error === "string" ? response.error : response.message;
        throw new Error(typeof message === "string" ? message : "API Application Error");
    }

    const recordKeys = listRecordKeysFor(resource);
    for (const key of recordKeys) {
        const records = response[key];
        if (Array.isArray(records)) {
            return normalizeListEnvelope(response, key);
        }
    }

    throw new Error(
        `Unrecognized list response format from API for resource ${resource}. Expected an array or an object containing ${recordKeys.join(", ")}.`,
    );
}

export const dataProvider = createElysiaDataProvider({
    apiUrl: getApiUrl(),
    withCredentials: true,
    parseListResponse,
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
          messages: messages.map(m => ({ role: m.role, content: m.content })),
          stream: true
        }),
        signal: options?.signal,
        credentials: 'include'
      });

      if (!res.ok) throw new Error('Chat API returned an error: ' + res.statusText);
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        const fallback = await res.json().catch(() => null);
        const content = fallback?.choices?.[0]?.message?.content;
        if (content) {
          yield content;
          return;
        }
        throw new Error('No readable stream');
      }

      let buffered = "";

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
            const data = JSON.parse(payload);
            if (data.choices?.[0]?.delta?.content) {
              yield data.choices[0].delta.content;
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
              const data = JSON.parse(payload);
              if (data.choices?.[0]?.delta?.content) {
                yield data.choices[0].delta.content;
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
