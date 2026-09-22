import {
  useList as unsafeUseList,
  useOne as unsafeUseOne,
  type UseListOptions,
  type UseOneOptions,
} from '@svadmin/core/unsafe';
import type { BaseRecord, GetListResult, GetOneResult } from '@svadmin/core';
import { createMutation, useQueryClient } from '@tanstack/svelte-query';
import { apiClient } from '$lib/api';

/**
 * Metadata-driven CRUD hooks retained by SVAdmin for resources without a runtime
 * contract. SupaCloud serves dynamic multi-tenant resources, so the strict
 * contract-bound hooks do not apply; these wrappers restore the caller-declared
 * row type while keeping the upstream unchecked transport behavior.
 */
type ListHookResult<T extends BaseRecord> = Omit<ReturnType<typeof unsafeUseList>, 'data'> & {
  data?: GetListResult<T>;
};

type ShowHookResult<T extends BaseRecord> = Omit<ReturnType<typeof unsafeUseOne>, 'data'> & {
  data?: GetOneResult<T>;
};

export function useList<T extends BaseRecord = BaseRecord>(
  options: Parameters<typeof unsafeUseList>[0],
): ListHookResult<T> {
  return unsafeUseList(options) as unknown as ListHookResult<T>;
}

export function useShow<T extends BaseRecord = BaseRecord>(
  options: UseOneOptions,
): ShowHookResult<T> {
  return unsafeUseOne(options) as unknown as ShowHookResult<T>;
}

export type { UseListOptions, UseOneOptions };

export interface CustomMutationOptions {
  url: string | ((variables: unknown) => string);
  method: 'post' | 'delete' | 'put' | 'patch';
  invalidates?: string[];
}

/**
 * Custom mutation hook for resource actions that are not expressible through the
 * metadata-driven CRUD hooks. The caller declares the endpoint, HTTP method and
 * the resource keys to invalidate; the transport stays bounded and validated by
 * the shared API client.
 */
export function useCustomMutation<TData = unknown>(options: CustomMutationOptions) {
  const client = useQueryClient();
  return createMutation(() => ({
    mutationFn: async (body?: unknown): Promise<TData> => {
      const url = typeof options.url === 'function' ? options.url(body) : options.url;
      const response = await apiClient(url, {
        method: options.method.toUpperCase(),
        ...(body === undefined
          ? {}
          : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new Error(`Request failed: ${response.status}`);
      return (await response.json()) as TData;
    },
    onSuccess: () => {
      for (const key of options.invalidates ?? []) {
        void client.invalidateQueries({ queryKey: [key] });
      }
    },
  }));
}