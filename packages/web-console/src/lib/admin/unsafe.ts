import {
  useList as unsafeUseList,
  useOne as unsafeUseOne,
  type UseListOptions,
  type UseOneOptions,
} from '@svadmin/core/unsafe';
import type { BaseRecord, GetListResult, GetOneResult } from '@svadmin/core';

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