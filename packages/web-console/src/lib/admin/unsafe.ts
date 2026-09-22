import {
  useList as unsafeUseList,
  useOne as unsafeUseOne,
  type UseOneOptions,
} from "@svadmin/core/unsafe";
import type { BaseRecord, GetListResult, GetOneResult } from "@svadmin/core";

type ListHookResult<T extends BaseRecord> = Omit<ReturnType<typeof unsafeUseList>, "data"> & {
  data?: GetListResult<T>;
};

type ShowHookResult<T extends BaseRecord> = Omit<ReturnType<typeof unsafeUseOne>, "data"> & {
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
