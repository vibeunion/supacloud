// Runtime reconciliation may restore schema lookup, but must preserve application
// GRANT/REVOKE decisions. Object privileges belong to application migrations.
export const TENANT_PUBLIC_SCHEMA_ACCESS_SQL = `
GRANT USAGE ON SCHEMA public TO service_role;
`;
