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

      if (!reader) throw new Error('No readable stream');

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const lines = decoder.decode(value).split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.choices?.[0]?.delta?.content) {
                yield data.choices[0].delta.content;
              }
            } catch {
              // Ignore parse errors on partial chunks
            }
          }
        }
      }
    } catch (e: any) {
      if (e.name === 'AbortError') return;
      yield `\n\n*(Error: ${e.message})*`;
    }
  }
};

