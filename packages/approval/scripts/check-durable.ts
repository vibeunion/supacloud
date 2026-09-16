import { assertLocalApprovalContainer } from './local-container.js';

const container=process.env.APPROVAL_TEST_CONTAINER ?? 'supacloud-approval-postgres-1';
await assertLocalApprovalContainer(container);
const child=Bun.spawn(['docker','exec','-i',container,'psql','-X','-Atq','-v','ON_ERROR_STOP=1',
  '-U','postgres','-d','postgres'], {
  stdin:new TextEncoder().encode('SET ROLE supacloud_approval_operator; SELECT approval.operational_health();'),
  stdout:'pipe',stderr:'pipe',
});
const [text,error,code]=await Promise.all([
  new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited,
]);
if (code!==0) throw new Error(error);
const health: unknown=JSON.parse(text.trim());
if (health===null || typeof health!=='object' || Array.isArray(health)) throw new Error('Invalid health response');
const report=health as Record<string,unknown>;
const maxAge=Number(process.env.APPROVAL_OUTCOME_MAX_AGE_SECONDS ?? '300');
if (!Number.isSafeInteger(maxAge) || maxAge<1) throw new Error('Invalid outcome delivery SLA');
const oldest=report.oldestUnacknowledgedOutcomeAt;
const overdueDelivery=oldest!==null && (typeof oldest!=='string' || !Number.isFinite(Date.parse(oldest))
  || Date.now()-Date.parse(oldest)>maxAge*1000);
const counters=['overdueRuns','failedExecutions','exhaustedRecoveries','exhaustedWakeups','exhaustedTimeouts','deadLetteredOutcomes',
  'overdueNotices','noticeDeadLetters','exhaustedNotices'];
const overdueNotices=typeof report.oldestNoticeAgeSeconds!=='number' || report.oldestNoticeAgeSeconds>maxAge;
const unhealthy=report.maintenanceStale!==false || !['pending','running'].includes(String(report.maintenanceStatus))
  || overdueDelivery || overdueNotices || counters.some(key=>typeof report[key]!=='number' || report[key]!==0);
console.log(JSON.stringify({healthy:!unhealthy,overdueDelivery,overdueNotices,...report},null,2));
process.exitCode=unhealthy ? 1 : 0;
