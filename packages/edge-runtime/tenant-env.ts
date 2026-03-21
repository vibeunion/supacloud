const TENANTS_DIR = process.env.TENANTS_DIR || "/etc/supabase/tenants";

/** Load tenant-specific environment variables from file */
export async function loadTenantEnv(
  projectRef: string,
): Promise<Record<string, string>> {
  const envMap: Record<string, string> = {};
  try {
    const text = await Bun.file(`${TENANTS_DIR}/${projectRef}.env`).text();
    for (const line of text.split("\n")) {
      const match = line.match(/^([^#=][^=]*)=(.*)$/);
      if (match) {
        envMap[match[1].trim()] = match[2].trim();
      }
    }
  } catch {
    // Tenant env file may not exist — proceed with empty env
  }
  return envMap;
}
