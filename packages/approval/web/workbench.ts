type WorkItem = {
  tenant: string; runId: string; entityId: string; definitionKey: string;
  definitionVersion: number; requester: string; status: string; stepIndex: number;
  rowVersion: string; round: number; rootRunId: string; createdAt: string; deadline: string;
  blockingReason: string | null;
};
import type { DurableApprovalReceipt } from '../src/durable.js';
type Run = DurableApprovalReceipt;

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector);
const rows = $('#rows') as HTMLTableSectionElement;
const feedback = $('#feedback') as HTMLParagraphElement;
const listState = $('#list-state') as HTMLParagraphElement;
const detail = $('#detail') as HTMLElement;
let csrf = '';
let view = 'inbox';
let items: WorkItem[] = [];
let selected: Run | null = null;
let before: { createdAt: string; runId: string } | null = null;
let eventsAfter = '0';
let roundsAfter = 0;
let listGeneration = 0;
let detailGeneration = 0;
let canOperate = false;
let mutationBusy = false;
let detailLoading = false;
let pendingCommand: { fingerprint: string; body: Record<string,unknown> } | null = null;
let pendingMigration: { fingerprint: string; body: Record<string,unknown> } | null = null;
let pendingNotice: { fingerprint: string; body: Record<string,unknown> } | null = null;
let noticesAfter: string | null = null;

function text(value: unknown): string { return value == null ? '' : String(value); }
function escape(value: unknown): string {
  return text(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}
function announce(message: string, error = false): void {
  feedback.textContent = message;
  feedback.dataset.error = error ? 'true' : 'false';
}
async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, headers: {
    accept: 'application/json',
    ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(init.method === 'POST' ? { 'x-csrf-token': csrf } : {}),
    ...(init.headers ?? {}),
  }, credentials: 'same-origin' });
  const value: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof value === 'object' && value !== null && 'error' in value ? text(value.error) : `HTTP_${response.status}`);
  return value as T;
}
function date(value: string): string {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : value;
}
function status(value: string): string {
  return ({ pending: '处理中', approved: '已通过', rejected: '已拒绝', returned: '已退回',
    cancelled: '已撤销', timed_out: '已超时' } as Record<string, string>)[value] ?? value;
}
function renderRows(): void {
  rows.innerHTML = items.map(item => `<tr data-selected="${selected?.id === item.runId}">
    <td><button data-run="${escape(item.runId)}">${escape(item.entityId)}</button></td>
    <td>${escape(item.definitionKey)} v${item.definitionVersion}</td>
    <td><span class="status" data-status="${escape(item.status)}">${escape(status(item.status))}</span></td>
    <td>${escape(date(item.deadline))}</td><td>${escape(item.round)}</td>
  </tr>`).join('');
  $('#count')!.textContent = `${items.length} 条`;
  $('#more')!.toggleAttribute('hidden', before === null);
}
async function loadList(reset = true): Promise<void> {
  if (reset) { items = []; before = null; }
  const generation = ++listGeneration;
  const currentView = view;
  listState.textContent = '正在加载';
  try {
    const query = new URLSearchParams({ view });
    if (before) { query.set('createdAt', before.createdAt); query.set('runId', before.runId); }
    const result = await api<{ items: WorkItem[]; next: { createdAt: string; runId: string } | null }>(`./api/runs?${query}`);
    if (generation !== listGeneration || currentView !== view) return;
    items = [...items, ...result.items];
    before = result.next;
    renderRows();
    listState.textContent = items.length === 0 ? '暂无记录' : '';
  } catch (error) {
    if (generation !== listGeneration) return;
    listState.textContent = '加载失败';
    announce(error instanceof Error ? error.message : '加载失败', true);
  }
}
function renderDetail(): void {
  if (!selected) { detail.hidden = true; return; }
  detail.hidden = false;
  $('#entity-title')!.textContent = selected.entityId;
  const summary = items.find(item => item.runId === selected?.id);
  $('#detail-state')!.textContent = `${status(selected.status)} · 第 ${selected.round ?? 1} 轮`;
  $('#summary')!.innerHTML = `<dt>流程</dt><dd>${escape(summary?.definitionKey ?? '审批分支')}${summary ? ` v${summary.definitionVersion}` : ''}</dd>
    <dt>申请人</dt><dd>${escape(summary?.requester ?? '—')}</dd><dt>截止时间</dt><dd>${escape(date(selected.deadline))}</dd>
    <dt>当前阻塞</dt><dd>${escape(selected.status === 'pending' ? summary?.blockingReason ?? '—' : '—')}</dd>`;
  $('#tasks')!.innerHTML = selected.tasks.map(task => `<li><span>${escape(task.actor)}</span><span class="status" data-status="${escape(task.status)}">${escape(status(task.status))}</span></li>`).join('');
  $('#graph')!.innerHTML = (selected.graphNodes ?? []).map(node =>
    `<button type="button" data-child="${escape(node.childRunId ?? '')}" data-status="${escape(node.status)}">${escape(node.key)}<span>${escape(status(node.status))}</span></button>`).join('');
  $('#run-id')!.textContent = selected.id;
  const form = $('#command') as HTMLFormElement;
  form.hidden = selected.status !== 'pending' && selected.status !== 'returned';
  $('#recovery')!.toggleAttribute('hidden', !canOperate);
  $('#notice-section')!.toggleAttribute('hidden', !canOperate);
  $('#snapshot-fields')!.toggleAttribute('hidden', selected.businessSnapshot === undefined);
  ($('#revision') as HTMLInputElement).value = selected.businessSnapshot?.revision ?? '';
  ($('#digest') as HTMLInputElement).value = selected.businessSnapshot?.sha256 ?? '';
  const action = $('#action') as HTMLSelectElement;
  action.value = selected.status === 'returned' ? 'resubmit' : 'approve';
  ($('#revision') as HTMLInputElement).readOnly = action.value !== 'resubmit';
  ($('#digest') as HTMLInputElement).readOnly = action.value !== 'resubmit';
  $('#target-field')!.setAttribute('hidden','');
  loadEvents(true).catch(error => announce(error instanceof Error ? error.message : '审计加载失败',true));
  loadRounds(true).catch(error => announce(error instanceof Error ? error.message : '轮次加载失败',true));
  if (canOperate) loadNotices(true).catch(error => announce(error instanceof Error ? error.message : '通知加载失败',true));
}
async function loadNotices(reset: boolean): Promise<void> {
  if (!selected || !canOperate) return;
  const runId = selected.id;
  const generation = detailGeneration;
  if (reset) noticesAfter = null;
  const result = await api<{
    noticeId: string;runId: string;kind: string;status: string;dueAt: string;
    attempts: number;recoveryAttempts: number;lastError: string | null;
  }[]>(`./api/runs/${runId}/notices${noticesAfter === null ? '' : `?after=${encodeURIComponent(noticesAfter)}`}`);
  if (generation !== detailGeneration || selected?.id !== runId) return;
  if (reset) $('#notices')!.innerHTML = '';
  $('#notices')!.insertAdjacentHTML('beforeend',result.map(item => `<li>
    ${item.kind === 'reminder' ? '催办' : '升级通知'} · ${escape(({scheduled:'待触发',ready:'待投递',cancelled:'已取消',acknowledged:'已送达',dead:'投递失败'} as Record<string,string>)[item.status] ?? item.status)}
    · ${escape(date(item.dueAt))} · ${item.attempts} 次
    ${item.lastError === null ? '' : `<code>${escape(item.lastError)}</code>`}
    ${item.status === 'dead' ? `<button data-notice="${escape(item.noticeId)}" data-attempts="${item.attempts}">重试</button>` : ''}
  </li>`).join(''));
  noticesAfter = result.at(-1)?.noticeId ?? noticesAfter;
  $('#notices-more')!.toggleAttribute('hidden',result.length < 50);
}
async function openRun(runId: string): Promise<void> {
  if (mutationBusy) return;
  const generation = ++detailGeneration;
  detailLoading = true;
  detail.inert = true;
  detail.setAttribute('aria-busy','true');
  try {
    const run = await api<Run>(`./api/runs/${encodeURIComponent(runId)}`);
    if (generation !== detailGeneration) return;
    selected = run;
    pendingCommand = null;
    pendingMigration = null;
    ($('#reason') as HTMLTextAreaElement).value = '';
    renderDetail();
    renderRows();
  } catch (error) { if (generation === detailGeneration) announce(error instanceof Error ? error.message : '详情加载失败', true); }
  finally {
    if (generation === detailGeneration) {
      detailLoading = false;
      detail.inert = false;
      detail.removeAttribute('aria-busy');
    }
  }
}
async function loadEvents(reset: boolean): Promise<void> {
  if (!selected) return;
  const runId = selected.id;
  const generation = detailGeneration;
  if (reset) eventsAfter = '0';
  const result = await api<{ id: string; kind: string; actor: string | null; detail: unknown; createdAt: string }[]>(
    `./api/runs/${encodeURIComponent(runId)}/events?after=${eventsAfter}`);
  if (generation !== detailGeneration || selected?.id !== runId) return;
  const list = $('#events')!;
  if (reset) list.innerHTML = '';
  list.insertAdjacentHTML('beforeend', result.map(event =>
    `<li><strong>${escape(event.kind)}</strong> ${escape(event.actor ?? '')}<time>${escape(date(event.createdAt))}</time><code>${escape(JSON.stringify(event.detail))}</code></li>`).join(''));
  if (result.length > 0) eventsAfter = result[result.length - 1]!.id;
  $('#events-more')!.toggleAttribute('hidden', result.length < 50);
}
async function loadRounds(reset: boolean): Promise<void> {
  if (!selected) return;
  const runId = selected.id;
  const generation = detailGeneration;
  if (reset) roundsAfter = 0;
  const result = await api<Run[]>(`./api/runs/${encodeURIComponent(runId)}/rounds?after=${roundsAfter}`);
  if (generation !== detailGeneration || selected?.id !== runId) return;
  const list = $('#rounds')!;
  if (reset) list.innerHTML = '';
  list.insertAdjacentHTML('beforeend', result.map(round => `<li><button data-run="${escape(round.id)}">第 ${round.round ?? 1} 轮 · ${escape(status(round.status))}</button></li>`).join(''));
  if (result.length > 0) roundsAfter = result[result.length - 1]!.round ?? 1;
  $('#rounds-more')!.toggleAttribute('hidden', result.length < 50);
}
function commandBody(): Record<string, unknown> {
  const action = ($('#action') as HTMLSelectElement).value;
  const body: Record<string, unknown> = {
    action, expectedVersion: selected?.rowVersion,
    reason: ($('#reason') as HTMLTextAreaElement).value,
  };
  const target = ($('#target') as HTMLInputElement).value.trim();
  if (target && ['transfer','delegate','resolve','add'].includes(action)) body.target = target;
  if (selected?.businessSnapshot) body.businessSnapshot = action === 'resubmit' ? {
    revision: ($('#revision') as HTMLInputElement).value,sha256: ($('#digest') as HTMLInputElement).value,
  } : selected.businessSnapshot;
  const fingerprint = JSON.stringify({ runId: selected?.id,...body });
  if (pendingCommand?.fingerprint !== fingerprint) pendingCommand = { fingerprint,body: { ...body,requestId: crypto.randomUUID() } };
  return pendingCommand.body;
}
async function submitCommand(event: Event): Promise<void> {
  event.preventDefault();
  if (!selected || mutationBusy || detailLoading) return;
  mutationBusy = true;
  const submit = $('#submit') as HTMLButtonElement;
  submit.disabled = true;
  try {
    const result = await api<Run>(`./api/runs/${encodeURIComponent(selected.id)}/command`, {
      method: 'POST', body: JSON.stringify(commandBody()),
    });
    selected = result;
    pendingCommand = null;
    ($('#reason') as HTMLTextAreaElement).value = '';
    detailGeneration++;
    announce('操作已提交');
    renderDetail();
    await loadList(true);
  } catch (error) { announce(error instanceof Error ? error.message : '操作失败', true); }
  finally { submit.disabled = false; mutationBusy = false; }
}
async function init(): Promise<void> {
  try {
    const session = await api<{ actor: string; csrfToken: string; operations: boolean }>('./api/session');
    csrf = session.csrfToken;
    canOperate = session.operations;
    $('#identity')!.textContent = session.actor;
    $('#operations')!.toggleAttribute('hidden', !session.operations);
    await loadList();
  } catch (error) { announce(error instanceof Error ? error.message : '无法连接审批服务', true); }
}
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-view]')) button.addEventListener('click', () => {
  view = button.dataset.view ?? 'inbox';
  for (const item of document.querySelectorAll('[data-view]')) item.setAttribute('aria-pressed', String(item === button));
  $('#list-title')!.textContent = ({ inbox: '我的待办', done: '已办', started: '我发起的', delegated: '委托给我' } as Record<string, string>)[view] ?? view;
  loadList().catch(() => undefined);
});
rows.addEventListener('click', event => {
  const target = (event.target as Element).closest<HTMLButtonElement>('[data-run]');
  if (target?.dataset.run) openRun(target.dataset.run).catch(() => undefined);
});
$('#graph')!.addEventListener('click', event => {
  const target = (event.target as Element).closest<HTMLButtonElement>('[data-child]');
  if (target?.dataset.child) openRun(target.dataset.child).catch(() => undefined);
});
$('#rounds')!.addEventListener('click', event => {
  const target = (event.target as Element).closest<HTMLButtonElement>('[data-run]');
  if (target?.dataset.run) openRun(target.dataset.run).catch(() => undefined);
});
$('#command')!.addEventListener('submit', event => submitCommand(event).catch(() => undefined));
$('#action')!.addEventListener('change', () => {
  const action = ($('#action') as HTMLSelectElement).value;
  $('#target-field')!.toggleAttribute('hidden', !['transfer','delegate','resolve','add'].includes(action));
  ($('#revision') as HTMLInputElement).readOnly = action !== 'resubmit';
  ($('#digest') as HTMLInputElement).readOnly = action !== 'resubmit';
});
$('#close-detail')!.addEventListener('click', () => {
  if (mutationBusy || detailLoading) return;
  detailGeneration++; selected = null; renderDetail(); renderRows();
});
$('#refresh')!.addEventListener('click', () => {
  if (mutationBusy || detailLoading) return;
  loadList().catch(() => undefined);
  if (selected) openRun(selected.id).catch(() => undefined);
});
$('#more')!.addEventListener('click', () => loadList(false).catch(() => undefined));
$('#events-more')!.addEventListener('click', () => loadEvents(false).catch(error => announce(error instanceof Error ? error.message : '审计加载失败',true)));
$('#rounds-more')!.addEventListener('click', () => loadRounds(false).catch(error => announce(error instanceof Error ? error.message : '轮次加载失败',true)));
$('#notices-more')!.addEventListener('click', () => loadNotices(false).catch(error => announce(error instanceof Error ? error.message : '通知加载失败',true)));
$('#notices')!.addEventListener('click',async event => {
  const button = (event.target as Element).closest<HTMLButtonElement>('[data-notice]');
  if (!button?.dataset.notice || !selected || mutationBusy || detailLoading) return;
  const body = { noticeId: button.dataset.notice,expectedAttempts: Number(button.dataset.attempts),
    reason: ($('#notice-reason') as HTMLInputElement).value };
  const fingerprint = JSON.stringify({ runId: selected.id,...body });
  if (pendingNotice?.fingerprint !== fingerprint) pendingNotice = {
    fingerprint,body: { ...body,requestId: crypto.randomUUID() },
  };
  mutationBusy = true;
  button.disabled = true;
  try {
    await api(`./api/runs/${selected.id}/recover-notice`,{ method: 'POST',body: JSON.stringify(pendingNotice.body) });
    pendingNotice = null;
    ($('#notice-reason') as HTMLInputElement).value = '';
    announce('通知已重新进入投递队列');
    await loadNotices(true);
    await loadEvents(true);
  } catch (error) { announce(error instanceof Error ? error.message : '通知重试失败',true); }
  finally { mutationBusy = false;button.disabled = false; }
});
$('#preview-open')!.addEventListener('click', () => ($('#preview-dialog') as HTMLDialogElement).showModal());
$('#preview-form')!.addEventListener('submit', event => {
  event.preventDefault();
  Promise.resolve().then(async () => api<unknown>('./api/preview',{ method: 'POST',body: JSON.stringify({
      definition: JSON.parse(($('#definition') as HTMLTextAreaElement).value) as unknown,
      samples: JSON.parse(($('#samples') as HTMLTextAreaElement).value) as unknown,
      facts: JSON.parse(($('#facts') as HTMLTextAreaElement).value) as unknown,
    }) })).then(result => { $('#preview-result')!.textContent = JSON.stringify(result,null,2); announce('流程校验通过'); })
      .catch(error => { $('#preview-result')!.textContent = error instanceof Error ? error.message : '预览失败'; announce('流程校验失败',true); });
});
$('#recover')!.addEventListener('click',async () => {
  if (!selected || mutationBusy || detailLoading) return;
  mutationBusy = true;
  const button = $('#recover') as HTMLButtonElement;
  button.disabled = true;
  try {
    await api(`./api/runs/${selected.id}/recover`,{ method: 'POST',body: JSON.stringify({
      kind: ($('#recovery-kind') as HTMLSelectElement).value,expectedEngine: selected.engineId,
      reason: ($('#recovery-reason') as HTMLInputElement).value,
    }) });
    announce('恢复请求已提交');
    await loadEvents(true);
  } catch (error) { announce(error instanceof Error ? error.message : '恢复失败',true); }
  finally { mutationBusy = false;button.disabled = false; }
});
$('#migrate')!.addEventListener('click',async () => {
  if (!selected || mutationBusy || detailLoading) return;
  if (!confirm('迁移会终止当前实例，并在目标版本重新审批。继续？')) return;
  mutationBusy = true;
  const button = $('#migrate') as HTMLButtonElement;
  button.disabled = true;
  try {
    const body = {
      expectedVersion: selected.rowVersion,
      targetVersion: Number(($('#migration-version') as HTMLInputElement).value),
      reason: ($('#migration-reason') as HTMLInputElement).value,
      ...(selected.businessSnapshot === undefined ? {} : { businessSnapshot: selected.businessSnapshot }),
    };
    const fingerprint = JSON.stringify({ runId: selected.id,...body });
    if (pendingMigration?.fingerprint !== fingerprint) pendingMigration = {
      fingerprint,body: { ...body,requestId: crypto.randomUUID() },
    };
    selected = await api<Run>(`./api/runs/${selected.id}/migrate`,{ method: 'POST',body: JSON.stringify(pendingMigration.body) });
    pendingMigration = null;
    detailGeneration++;
    renderDetail();
    announce('实例已迁移，新实例重新审批');
    await loadList();
  } catch (error) { announce(error instanceof Error ? error.message : '迁移失败',true); }
  finally { mutationBusy = false;button.disabled = false; }
});
$('#operations')!.addEventListener('click', async () => {
  try {
    const health = await api<Record<string, unknown>>('./api/health');
    $('#health')!.innerHTML = Object.entries(health).map(([key,value]) => `<span>${escape(key)}</span><strong>${escape(JSON.stringify(value))}</strong>`).join('');
    ($('#health-dialog') as HTMLDialogElement).showModal();
  } catch (error) { announce(error instanceof Error ? error.message : '健康检查失败',true); }
});
init().catch(() => undefined);
