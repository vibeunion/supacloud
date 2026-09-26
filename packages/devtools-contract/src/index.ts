/**
 * @supacloud/devtools-contract
 *
 * Re-export shim over `@vibeunion/devtools-protocol`, the single source of
 * truth for JSON-safe DevTools contracts shared by frontend, svadmin, and
 * SupaCloud adapters.
 *
 * The package intentionally owns no contract definitions of its own: keeping a
 * second copy here was how the frontend / svadmin / SupaCloud contracts drifted
 * apart. SupaCloud-specific mapping lives in `@vibeunion/devtools-supacloud`.
 */
export * from '@vibeunion/devtools-protocol';