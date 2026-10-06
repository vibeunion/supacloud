import { defineResource, type ContractSchemas, type ResourceContract } from '@svadmin/core/resource-contract';

export type SvadminResourceContract<S extends ContractSchemas['record']> =
  ResourceContract<{ record: S }>;

export const defineSvadminResource = defineResource;

export function defineDynamicSvadminResource<S extends ContractSchemas['record']>(
  name: string,
  schemas: { record: S },
): SvadminResourceContract<S> {
  // Live column metadata cannot satisfy static SafeSchema inference; defineResource
  // still validates and closes every schema at this single dynamic boundary.
  return (defineResource as unknown as (
    name: string, schemas: { record: S },
  ) => SvadminResourceContract<S>)(name, schemas);
}
