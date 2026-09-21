export const globalServiceUnits = {
  postgresql: "patroni",
  realtime: "supacloud-realtime",
  storage: "supacloud-storage",
  caddy: "supacloud-caddy",
} as const;

export function projectServiceUnits(ref: string) {
  return {
    postgrest: `supacloud-pgrst@${ref}`,
    rest: `supacloud-pgrst@${ref}`,
    gotrue: `supacloud-gotrue@${ref}`,
    auth: `supacloud-gotrue@${ref}`,
  };
}
