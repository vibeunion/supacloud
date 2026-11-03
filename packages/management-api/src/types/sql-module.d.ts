/**
 * Main `tsc --noEmit` sees Reylo query modules as opaque values so it can type
 * check callers without a live database. `tsconfig.reylo.json` deliberately
 * excludes this shim and checks the real inferred query types with the content
 * mapper instead.
 */
declare module "*.sql" {
  const query: any;
  export default query;
}
