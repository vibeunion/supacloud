import { createElysiaDataProvider } from '@svadmin/elysia';
import type { ChatProvider, ChatMessage } from '@svadmin/core';

const getApiUrl = () => {
    if (typeof window === 'undefined') return 'http://localhost:9090'; // SSR
    return window.location.origin;
};

// ... DataProvider logic ...
export const dataProvider = createElysiaDataProvider({
    apiUrl: getApiUrl(),
    headers: (): Record<string, string> => {
        const token = typeof localStorage !== 'undefined' ? localStorage.getItem("supacloud_session") : null;
        if (token) {
            return {
                Authorization: `Bearer ${token}`
            };
        }
        return {};
    },
    parseListResponse: (json: any, resource: string) => {
        if (json && (json.error || json.message)) {
            const msg = typeof json.error === "string" ? json.error : json.message;
            throw new Error(msg || "API Application Error");
        }
        if (Array.isArray(json)) return { data: json, total: json.length };
        if (json && Array.isArray(json.items)) return { data: json.items, total: json.total ?? json.items.length };
        if (json && Array.isArray(json.data)) return { data: json.data, total: json.total ?? json.data.length };
        if (json && json.rows && Array.isArray(json.rows)) return { data: json.rows, total: json.total ?? json.rows.length };
        throw new Error(`Unrecognized list response format from API for resource ${resource}. Expected { items, total }, { data, total }, or an array.`);
    }
});

// Implementation of ChatProvider using Fetch API + SSE for streaming
export const chatProvider: ChatProvider = {
  async *sendMessage(messages: ChatMessage[], options?: { signal?: AbortSignal }): AsyncGenerator<string, void, unknown> {
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem("supacloud_session") : null;
    try {
      // Direct integration with an OpenAI-compatible /v1/chat/completions endpoint
      // You can point this to your actual locally run proxy/LLM backend
      const res = await fetch(`${getApiUrl()}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {})
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini', // Update dynamically if needed
          messages: messages.map(m => ({ role: m.role, content: m.content })),
          stream: true
        }),
        signal: options?.signal
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
    } catch (e: any) {
      if (e.name === 'AbortError') return;
      yield `\n\n*(Error: ${e.message})*`;
    }
  }
};
