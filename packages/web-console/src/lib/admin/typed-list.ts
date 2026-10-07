import type {
  ContractFilter, ContractSort, GetListParams, GetListResult, ResourceDefinition,
} from '@svadmin/core';
import {
  contractProvider,
  parseContractRecord,
  type ContractRecord,
  type ContractSchemas,
  type ResourceContract,
} from '@svadmin/core/resource-contract';
import { dataProvider } from './provider';

/**
 * Bind transport and decoding to the same resource. A caller cannot select a
 * response type independently of the schema that validates the actual records.
 */
export async function getResourceList<S extends ContractSchemas>(
  resource: Omit<ResourceDefinition, 'contract'> & { contract: ResourceContract<S> },
  params: Omit<GetListParams, 'resource' | 'filters' | 'sorters'> & {
    filters?: ContractFilter<NoInfer<ContractRecord<S>>>[];
    sorters?: ContractSort<NoInfer<ContractRecord<S>>>[];
  } = {},
): Promise<GetListResult<ContractRecord<S>>> {
  const result = await contractProvider(dataProvider, resource.contract).getList({
    ...params,
    resource: resource.name,
    meta: { ...params.meta, ...resource.provider?.meta },
  });
  return {
    ...result,
    data: result.data.map((record) => parseContractRecord(resource.contract, record)),
  };
}
