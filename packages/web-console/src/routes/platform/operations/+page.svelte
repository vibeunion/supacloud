<script lang="ts">
  import { apiClient } from "$lib/api";

  import { onMount } from "svelte";
  import { Loader2, Wrench, Play, RefreshCw, AlertTriangle, CheckCircle2, Server, ArrowRightLeft, Plus, Shield, Clock, Terminal } from "lucide-svelte";
  import { locale } from "svelte-i18n";

  interface Operation {
    id: string;
    name: string;
    desc: string;
    icon: typeof import('lucide-svelte').RefreshCw;
    danger: boolean;
    fields: { key: string; label: string; placeholder: string; required: boolean }[];
    action: (params: Record<string, string>) => Promise<string>;
  }

  let activeOp: string | null = $state.raw(null);
  let opParams: Record<string, string> = $state.raw({});
  let isExecuting = $state(false);
  let logs: { time: string; op: string; result: string; success: boolean }[] = $state.raw([]);

  // Health Check
  let healthStatus: unknown = $state.raw(null);
  let isCheckingHealth = $state(false);

  const isZh = $derived(($locale ?? "").toLowerCase().startsWith("zh"));
  const tr = (zh: string, en: string) => isZh ? zh : en;

  async function apiCall(url: string, method: string = "GET", body?: unknown): Promise<Record<string, unknown>> {
    const opts: RequestInit = { method, headers: { "Content-Type": "application/json" } };
    if (body) opts.body = JSON.stringify(body);
    const res = await apiClient(url, opts);
    return await res.json();
  }

  const OPERATIONS: Operation[] = $derived([
    {
      id: "reload",
      name: tr("重载配置", "Reload configuration"),
      desc: tr("在线重载 PostgreSQL 配置文件（postgresql.conf），无需重启数据库", "Reload PostgreSQL configuration (postgresql.conf) without restarting the database"),
      icon: RefreshCw,
      danger: false,
      fields: [
        { key: "ip", label: tr("节点 IP", "Node IP"), placeholder: "127.0.0.1", required: true },
      ],
      action: async (params) => {
        const data = await apiCall("/v1/maintenance/reload", "POST", { ip: params.ip });
        return String(data.message || JSON.stringify(data));
      }
    },
    {
      id: "switchover",
      name: tr("主从切换", "Primary switchover"),
      desc: tr("将主库切换到指定从库节点。这是计划内维护操作，会有短暂不可用", "Switch the primary to a specified replica. This is a planned maintenance operation with brief downtime"),
      icon: ArrowRightLeft,
      danger: true,
      fields: [
        { key: "cluster", label: tr("集群名称", "Cluster name"), placeholder: "db-main", required: false },
        { key: "candidate", label: tr("候选从库", "Candidate replica"), placeholder: tr("留空则自动选择", "Leave blank to auto-select"), required: false },
      ],
      action: async (params) => {
        const data = await apiCall("/v1/maintenance/switchover", "POST", {
          cluster: params.cluster || "db-main",
          candidate: params.candidate || undefined
        });
        return String(data.message || JSON.stringify(data));
      }
    },
    {
      id: "add_replica",
      name: tr("添加从库", "Add replica"),
      desc: tr("将新节点加入为只读从库，自动配置流式复制。这是一个长时间异步任务", "Add a new node as a read-only replica with streaming replication. This is a long-running async task"),
      icon: Plus,
      danger: false,
      fields: [
        { key: "ip", label: tr("新节点 IP", "New node IP"), placeholder: "10.10.10.12", required: true },
      ],
      action: async (params) => {
        const data = await apiCall("/v1/maintenance/replicas", "POST", { ip: params.ip });
        return String(data.message || JSON.stringify(data));
      }
    },
  ];

  async function executeOp(op: Operation) {
    // Validate required fields
    for (const field of op.fields) {
      if (field.required && !opParams[field.key]?.trim()) {
        addLog(op.name, `❌ ${tr("请填写", "Please fill in")} ${field.label}`, false);
        return;
      }
    }
    if (op.danger && !confirm(`⚠️ ${tr("危险操作确认：", "Dangerous operation confirmation:")}\n\n${tr("即将执行", "About to execute")}「${op.name}」\n${op.desc}\n\n${tr("确定继续？", "Continue?")}`)) return;

    isExecuting = true;
    try {
      const result = await op.action(opParams);
      addLog(op.name, result, true);
    } catch (err: unknown) {
      addLog(op.name, (err instanceof Error ? err.message : String(err)), false);
    } finally {
      isExecuting = false;
    }
  }

  function addLog(op: string, result: string, success: boolean) {
    const now = new Date();
    const time = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}:${now.getSeconds().toString().padStart(2,'0')}`;
    logs = [{ time, op, result, success }, ...logs].slice(0, 50);
  }

  async function checkHealth() {
    isCheckingHealth = true;
    try {
      const data = await apiCall("/monitor/health");
      healthStatus = data;
      addLog(tr("健康检查", "Health check"), tr("检查完成", "Completed"), true);
    } catch (err: unknown) {
      addLog(tr("健康检查", "Health check"), (err instanceof Error ? err.message : String(err)), false);
    }
    isCheckingHealth = false;
  }

  function selectOp(id: string) {
    activeOp = activeOp === id ? null : id;
    opParams = {};
  }

  // Health check translations
  function translateComponent(name: string) {
    const map: Record<string, string> = {
      "Storage Space": tr("存储空间", "Storage Space"),
      "Memory Status": tr("系统内存", "Memory Status"),
      "Management API": tr("SupaCloud 管理接口", "SupaCloud Management API"),
      "Pigsty Infrastructure": tr("Pigsty 基础设施", "Pigsty Infrastructure"),
      "Database (PostgreSQL)": tr("Database (PostgreSQL)", "Database (PostgreSQL)"),
      "Cloud-native Storage": tr("云原生存储", "Cloud-native Storage"),
      "Cloud-native Storage (JuiceFS)": tr("云原生存储 (JuiceFS)", "Cloud-native Storage (JuiceFS)"),
      "Database Connection": tr("数据库连接", "Database Connection"),
      "Database Cluster (HA)": tr("数据库集群 (HA高可用)", "Database Cluster (HA)"),
      "Pigsty Engine": tr("Pigsty 引擎", "Pigsty Engine")
    };
    return map[name] || name;
  }

  function translateMessage(msg: string) {
    if (!msg) return msg;
    if (!isZh) return msg;
    if (msg === "Running") return "正在运行";
    if (msg === "Service stopped") return "服务已停止";
    if (msg === "System not booted by Systemd") return "非 Systemd 启动环境，服务状态未知";
    if (msg === "Cloud-native storage backend not mounted") return "云原生存储后端未挂载或未配置";
    if (msg === "Cannot detect storage mount status") return "无法检测存储挂载状态";
    if (msg === "Cannot get disk info") return "无法获取系统磁盘信息";
    if (msg === "Database not accepting connections") return "数据库目前拒绝访问连接";
    if (msg === "Cannot access service status") return "无法获取服务运行状态";
    
    // Dynamic replacements
    let translated = msg;
    translated = translated.replace(/^Available:\s*(.*)/, "剩余可用: $1");
    translated = translated.replace(/^Mounted:\s*(.*)/, "已挂载: $1");
    translated = translated.replace(/^Free (.*?) \/ Total (.*?)$/, "空闲 $1 / 总量 $2");
    translated = translated.replace(/^PG (.*?) running in single-node mode$/, "PostgreSQL $1 - 单节点独立运行中");
    translated = translated.replace(/^Ready \((.+?)\)$/, "目前就绪 ($1)");

    return translated;
  }

  onMount(() => checkHealth());
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h2 class="text-xl font-bold">{tr("运维操作", "Operations")}</h2>
      <p class="text-xs text-muted-foreground mt-1">{tr("精选的 Pigsty / Patroni 运维操作，以安全的工单式 UI 执行", "Curated Pigsty / Patroni operations executed through a safe ticket-style UI")}</p>
    </div>
  </div>

  <!-- Health Check Panel -->
  <div class="rounded-xl border bg-card overflow-hidden">
    <div class="border-b px-5 py-3 bg-muted/20 flex items-center justify-between">
      <h3 class="text-sm font-semibold flex items-center gap-2"><Shield size={16} /> {tr("集群健康检查", "Cluster health check")}</h3>
      <button onclick={checkHealth} disabled={isCheckingHealth} class="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-md bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50">
        {#if isCheckingHealth}<Loader2 size={12} class="animate-spin" />{:else}<RefreshCw size={12} />{/if}
        {tr("执行检查", "Run Check")}
      </button>
    </div>
    <div class="p-4">
      {#if !healthStatus}
        <p class="text-xs text-muted-foreground">{tr("正在进行健康检查...", "Health check in progress...")}</p>
      {:else}
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
          {#each (healthStatus as any[]) as report}
            <div class="rounded-lg border p-3 flex flex-col justify-between">
              <div class="text-[10px] font-bold uppercase text-muted-foreground mb-1">{translateComponent(report.component)}</div>
              <div class="mt-1">
                <span class="text-xs font-bold px-1.5 py-0.5 rounded-sm {report.status === 'OK' ? 'bg-green-100 text-green-700' : report.status === 'ERROR' ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-700'}">
                  {report.status}
                </span>
              </div>
              <div class="text-xs text-muted-foreground mt-2 line-clamp-2" title={translateMessage(report.message)}>
                {translateMessage(report.message)}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>

  <!-- Operations Cards -->
  <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
    {#each OPERATIONS as op}
      {@const Icon = op.icon}
      <div class="rounded-xl border bg-card overflow-hidden {activeOp === op.id ? 'ring-2 ring-brand' : ''}">
        <button
          onclick={() => selectOp(op.id)}
          class="w-full text-left border-b px-5 py-4 hover:bg-muted/20 transition-colors"
        >
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-lg flex items-center justify-center {op.danger ? 'bg-red-500/10 text-red-500' : 'bg-brand/10 text-brand'}">
              <Icon size={20} />
            </div>
            <div>
              <div class="flex items-center gap-2">
                <span class="text-sm font-bold">{op.name}</span>
                {#if op.danger}
                  <span class="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-red-500/10 text-red-600 border border-red-500/20">{tr("危险", "Danger")}</span>
                {/if}
              </div>
              <p class="text-[10px] text-muted-foreground mt-0.5">{op.desc}</p>
            </div>
          </div>
        </button>

        {#if activeOp === op.id}
          <div class="p-4 space-y-3">
            {#each op.fields as field}
              <div>
                <label for="op-{op.id}-{field.key}" class="text-xs font-semibold text-muted-foreground block mb-1">
                  {field.label} {#if field.required}<span class="text-red-500">*</span>{/if}
                </label>
                <input id="op-{op.id}-{field.key}"
                  bind:value={opParams[field.key]}
                  placeholder={field.placeholder}
                  class="w-full px-3 py-2 text-xs font-mono rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand"
                />
              </div>
            {/each}
            <button
              onclick={() => executeOp(op)}
              disabled={isExecuting}
              class="w-full px-4 py-2 text-xs font-semibold rounded-lg transition-colors flex items-center justify-center gap-2 disabled:opacity-50
                {op.danger ? 'bg-red-600 text-white hover:bg-red-700' : 'bg-brand text-white hover:bg-brand/90'}"
            >
              {#if isExecuting}<Loader2 size={14} class="animate-spin" />{:else}<Play size={14} />{/if}
              {tr("执行操作", "Execute")}
            </button>
          </div>
        {/if}
      </div>
    {/each}
  </div>

  <!-- Operation Logs -->
  <div class="rounded-xl border bg-card overflow-hidden">
    <div class="border-b px-5 py-3 bg-muted/20 flex items-center justify-between">
      <h3 class="text-sm font-semibold flex items-center gap-2"><Terminal size={16} /> {tr("操作日志", "Operation Logs")}</h3>
      {#if logs.length > 0}
        <button onclick={() => logs = []} class="text-[10px] text-muted-foreground hover:text-foreground">{tr("清除", "Clear")}</button>
      {/if}
    </div>
    {#if logs.length === 0}
      <div class="p-8 text-center text-muted-foreground text-xs">{tr("还没有执行过任何操作", "No operations have been executed yet")}</div>
    {:else}
      <div class="overflow-auto max-h-64">
        <table class="w-full text-left text-xs">
          <thead class="bg-muted/30 border-b sticky top-0">
            <tr>
              <th class="px-4 py-2 font-semibold text-muted-foreground w-20">{tr("时间", "Time")}</th>
              <th class="px-3 py-2 font-semibold text-muted-foreground w-24">{tr("操作", "Operation")}</th>
              <th class="px-3 py-2 font-semibold text-muted-foreground w-12">{tr("状态", "Status")}</th>
              <th class="px-3 py-2 font-semibold text-muted-foreground">{tr("结果", "Result")}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border/20 font-mono">
            {#each logs as log}
              <tr class="hover:bg-muted/10">
                <td class="px-4 py-2 text-muted-foreground">{log.time}</td>
                <td class="px-3 py-2 font-medium">{log.op}</td>
                <td class="px-3 py-2">
                  {#if log.success}<CheckCircle2 size={14} class="text-green-500" />{:else}<AlertTriangle size={14} class="text-red-500" />{/if}
                </td>
                <td class="px-3 py-2 text-muted-foreground truncate max-w-sm">{log.result}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>

  <div class="rounded-lg border bg-blue-500/5 border-blue-500/20 p-3 flex items-start gap-2">
    <Wrench size={14} class="text-blue-600 mt-0.5 shrink-0" />
    <div class="text-xs text-blue-700">
      <b>{tr("安全说明：", "Safety note:")}</b>{tr("这里仅暴露了经过安全评估的运维操作。完整的 Ansible Playbook 和 pigsty.yml 配置编辑请通过 SSH 终端操作。", "Only safety-reviewed operations are exposed here. Use SSH for full Ansible Playbook and pigsty.yml editing.")} {tr("所有操作都会记录在上方的操作日志中以供审计。", "All actions are logged above for auditing.")}
    </div>
  </div>
</div>
