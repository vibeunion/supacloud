import { assertLocalApprovalContainer } from './local-container.js';
import { loadApprovalMigrations, migrationScript } from './migrations.js';

const container = process.env.APPROVAL_TEST_CONTAINER ?? 'supacloud-approval-postgres-1';
if (process.argv.slice(2).some(arg=>!['--adopt-baseline','--render'].includes(arg))) {
  throw new Error('Supported options: --render, --adopt-baseline');
}
const sql = migrationScript(await loadApprovalMigrations(), process.argv.includes('--adopt-baseline'))
  + '\nSET ROLE supacloud_approval_operator;\nSELECT approval.ensure_maintenance();\n';
if (process.argv.includes('--render')) {
  process.stdout.write(sql);
} else {
  await assertLocalApprovalContainer(container);
  const child = Bun.spawn(['docker', 'exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
    '-U', 'postgres', '-d', 'postgres'], { stdin: new TextEncoder().encode(sql), stdout: 'inherit', stderr: 'inherit' });
  if (await child.exited !== 0) throw new Error('Approval migration failed');
}
