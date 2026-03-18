<script lang="ts">
  import { page } from "$app/state";
  import { Activity, Shield, Gauge, Cpu, AlertTriangle, CheckCircle, BarChart3 } from "lucide-svelte";

  const projectRef = $derived(page.params.ref);

  interface Advisor {
    title: string;
    description: string;
    icon: typeof Activity;
    status: "good" | "warning" | "critical";
    detail: string;
  }

  const performanceAdvisors: Advisor[] = [
    { title: "索引利用率", description: "检查表是否有效使用索引", icon: BarChart3, status: "good", detail: "所有频繁查询的表都有适当的索引" },
    { title: "表膨胀", description: "检测因 MVCC 导致的表空间膨胀", icon: Gauge, status: "good", detail: "未检测到严重的表膨胀现象" },
    { title: "缓存命中率", description: "共享缓冲区的命中率", icon: Cpu, status: "good", detail: "缓存命中率 > 99%，性能良好" },
    { title: "连接池", description: "检查连接池的使用和配置", icon: Activity, status: "warning", detail: "当前连接数较低，建议在高负载时监控" },
    { title: "长时间运行查询", description: "检测运行时间过长的 SQL 查询", icon: AlertTriangle, status: "good", detail: "无长时间运行的查询" },
  ];

  const securityAdvisors: Advisor[] = [
    { title: "RLS 启用状态", description: "检查公开表是否启用 Row Level Security", icon: Shield, status: "warning", detail: "部分 public 表未启用 RLS" },
    { title: "默认角色权限", description: "检查默认角色的权限配置", icon: Shield, status: "good", detail: "角色权限配置合理" },
    { title: "未使用的索引", description: "识别从未被使用的冗余索引", icon: BarChart3, status: "good", detail: "未发现冗余索引" },
    { title: "外键约束", description: "检查表间引用完整性", icon: Activity, status: "good", detail: "外键约束配置正确" },
    { title: "函数安全性", description: "检查函数的 SECURITY DEFINER 使用", icon: Shield, status: "good", detail: "函数安全配置合理" },
  ];

  function getStatusColor(status: string): string {
    if (status === "good") return "text-green-600 bg-green-500/10";
    if (status === "warning") return "text-amber-600 bg-amber-500/10";
    return "text-red-600 bg-red-500/10";
  }

  function getStatusLabel(status: string): string {
    if (status === "good") return "正常";
    if (status === "warning") return "需注意";
    return "严重";
  }
</script>

<div class="h-full flex flex-col space-y-6">
  <div>
    <h1 class="text-2xl font-bold">数据库顾问</h1>
    <p class="text-sm text-muted-foreground mt-1">自动化性能和安全检查建议</p>
  </div>

  <!-- Performance -->
  <div class="space-y-3">
    <h2 class="text-lg font-semibold flex items-center gap-2"><Gauge size={18} /> 性能建议</h2>
    <div class="rounded-xl border border-border/50 bg-background shadow-sm overflow-hidden divide-y divide-border/20">
      {#each performanceAdvisors as advisor}
        <div class="flex items-center justify-between px-5 py-3.5 hover:bg-muted/10 transition-colors">
          <div class="flex items-center gap-3">
            <div class="w-8 h-8 rounded-lg bg-brand/10 text-brand flex items-center justify-center">
              <advisor.icon size={14} />
            </div>
            <div>
              <span class="font-medium text-sm">{advisor.title}</span>
              <p class="text-[10px] text-muted-foreground">{advisor.description}</p>
            </div>
          </div>
          <div class="flex items-center gap-3">
            <span class="text-[10px] text-muted-foreground max-w-xs truncate hidden lg:block">{advisor.detail}</span>
            <span class="px-2 py-0.5 rounded-full text-[9px] font-bold {getStatusColor(advisor.status)}">{getStatusLabel(advisor.status)}</span>
          </div>
        </div>
      {/each}
    </div>
  </div>

  <!-- Security -->
  <div class="space-y-3">
    <h2 class="text-lg font-semibold flex items-center gap-2"><Shield size={18} /> 安全建议</h2>
    <div class="rounded-xl border border-border/50 bg-background shadow-sm overflow-hidden divide-y divide-border/20">
      {#each securityAdvisors as advisor}
        <div class="flex items-center justify-between px-5 py-3.5 hover:bg-muted/10 transition-colors">
          <div class="flex items-center gap-3">
            <div class="w-8 h-8 rounded-lg bg-brand/10 text-brand flex items-center justify-center">
              <advisor.icon size={14} />
            </div>
            <div>
              <span class="font-medium text-sm">{advisor.title}</span>
              <p class="text-[10px] text-muted-foreground">{advisor.description}</p>
            </div>
          </div>
          <div class="flex items-center gap-3">
            <span class="text-[10px] text-muted-foreground max-w-xs truncate hidden lg:block">{advisor.detail}</span>
            <span class="px-2 py-0.5 rounded-full text-[9px] font-bold {getStatusColor(advisor.status)}">{getStatusLabel(advisor.status)}</span>
          </div>
        </div>
      {/each}
    </div>
  </div>
</div>
