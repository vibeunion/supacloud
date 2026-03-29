<script lang="ts">


  import { page } from "$app/state";
  import { Loader2, Cpu, HardDrive, Activity, Gauge } from "lucide-svelte";

  const projectRef = $derived(page.params.ref);

  interface InfraItem {
    name: string;
    description: string;
    value: string;
    icon: typeof Cpu;
    category: "compute" | "storage" | "network";
  }

  const infraItems: InfraItem[] = [
    { name: "计算实例", description: "当前实例规格和 CPU/内存配置", value: "Micro (共享 2 vCPU / 1 GB RAM)", icon: Cpu, category: "compute" },
    { name: "数据库磁盘", description: "数据库磁盘类型和大小", value: "8 GB SSD (gp3)", icon: HardDrive, category: "storage" },
    { name: "IOPS", description: "数据库磁盘每秒 I/O 操作数", value: "3000 IOPS", icon: Gauge, category: "storage" },
    { name: "带宽", description: "网络入站/出站带宽限制", value: "无限制 (自管理)", icon: Activity, category: "network" },
    { name: "连接池", description: "Supavisor 连接池配置", value: "事务模式 / 最大 200 连接", icon: Activity, category: "network" },
    { name: "自动暂停", description: "不活跃时是否自动暂停实例", value: "已禁用 (自管理)", icon: Cpu, category: "compute" },
    { name: "点对点恢复", description: "数据库可恢复到任意时间点", value: "WAL 级别 (自管理)", icon: HardDrive, category: "storage" },
  ];

  function getCategoryLabel(cat: string): string {
    if (cat === "compute") return "计算";
    if (cat === "storage") return "存储";
    return "网络";
  }
  
  function getCategoryColor(cat: string): string {
    if (cat === "compute") return "text-blue-600 bg-blue-500/10";
    if (cat === "storage") return "text-violet-600 bg-violet-500/10";
    return "text-green-600 bg-green-500/10";
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div>
    <h1 class="text-2xl font-bold">基础设施</h1>
    <p class="text-sm text-muted-foreground mt-1">项目的计算、存储和网络基础设施配置</p>
  </div>

  <div class="space-y-3">
    {#each infraItems as item}
      <div class="rounded-xl border bg-card p-4 flex items-center justify-between hover:bg-muted/5 transition-colors">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-lg bg-brand/10 text-brand flex items-center justify-center">
            <item.icon size={16} />
          </div>
          <div>
            <span class="font-semibold text-sm">{item.name}</span>
            <p class="text-[10px] text-muted-foreground">{item.description}</p>
          </div>
        </div>
        <div class="flex items-center gap-3">
          <span class="px-1.5 py-0.5 rounded text-[9px] font-bold {getCategoryColor(item.category)}">{getCategoryLabel(item.category)}</span>
          <span class="text-xs font-mono text-foreground">{item.value}</span>
        </div>
      </div>
    {/each}
  </div>
</div>
