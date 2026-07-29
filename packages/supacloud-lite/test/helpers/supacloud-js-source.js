// Runtime bridge: exercise the workspace SDK source without pulling its
// separate TypeScript project into SupaCloud Lite's typecheck graph.
export { createSupaCloudClient } from '../../../supacloud-js/src/index.ts'
