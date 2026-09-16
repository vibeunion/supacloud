export async function assertLocalApprovalContainer(container: string): Promise<void> {
  if (!/^supacloud-approval-[a-z0-9-]+$/.test(container)) {
    throw new Error('Use a dedicated supacloud-approval-* local container');
  }
  async function read(args: string[]) {
    const child = Bun.spawn(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' });
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (code !== 0) throw new Error(error);
    return output.trim();
  }
  if (process.env.DOCKER_HOST || process.env.DOCKER_CONTEXT) {
    throw new Error('Unset Docker connection overrides for local approval tooling');
  }
  const endpoint = await read(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
  if (!endpoint.startsWith('unix://')) throw new Error('A local Unix Docker endpoint is required');
  const project = await read(['inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}', container]);
  if (project !== 'supacloud-approval') throw new Error('Dedicated approval Compose project required');
}
