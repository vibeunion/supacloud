import { parseContractRecord } from '@svadmin/core/resource-contract';
import { tenantAuthUsersContract, tenantTablesContract } from './contracts';
import { getTenantResources, type TenantResourceLabels } from './resources';
import { getResourceList } from './typed-list';

// Compiled by resources.test.ts; never executed or imported into the application.
export async function checkResourceInference(labels: TenantResourceLabels) {
  const [tables, users] = getTenantResources('alpha', labels);
  const tableList = await getResourceList(tables);
  const name: string = tableList.data[0]!.table_name;
  const estimate: string | number = tableList.data[0]!.row_estimate;
  // @ts-expect-error Table names cannot be assigned to a numeric field.
  const numericName: number = tableList.data[0]!.table_name;
  // @ts-expect-error Table records do not contain auth user fields.
  tableList.data[0]!.email;
  const userList = await getResourceList(users);
  await getResourceList(users, { filters: [{ field: 'email', operator: 'eq', value: 'a@example.com' }] });
  // @ts-expect-error Filter values must match the resource field.
  await getResourceList(users, { filters: [{ field: 'email', operator: 'eq', value: 42 }] });
  // @ts-expect-error Sort fields must belong to the resource.
  await getResourceList(tables, { sorters: [{ field: 'email', order: 'asc' }] });
  const email: string | null | undefined = userList.data[0]!.email;
  // @ts-expect-error Auth user records do not contain database table fields.
  userList.data[0]!.table_name;
  const table = parseContractRecord(tenantTablesContract('alpha'), {});
  const user = parseContractRecord(tenantAuthUsersContract('alpha'), {});
  const tableName: string = table.table_name;
  const userId: string = user.id;
  // @ts-expect-error Contracts, not caller-supplied record types, select the result.
  await getResourceList<{ id: string; arbitrary: boolean }>(tables);
  return { name, estimate, numericName, email, tableName, userId };
}
