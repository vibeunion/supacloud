<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { BarChart3, Activity, Database, Shield, Zap, HardDrive, Clock, TrendingUp, ArrowRight } from "lucide-svelte";

  const projectRef = $derived(page.params.ref);

  const REPORT_SECTIONS = [
    {
      id: "overview",
      title: "API 概览",
      desc: "API 网关请求量、延迟、错误率统计",
      icon: Activity,
      color: "text-blue-600 bg-blue-500/10",
      href: "api-overview",
    },
    {
      id: "database",
      title: "数据库",
      desc: "数据库连接数、磁盘利用率、缓存命中率统计",
      icon: Database,
      color: "text-violet-600 bg-violet-500/10",
      href: "database",
    },
    {
      id: "query-performance",
      title: "查询性能",
      desc: "慢查询分析、执行计划统计（pg_stat_statements）",
      icon: Clock,
      color: "text-amber-600 bg-amber-500/10",
      href: "query-performance",
    },
    {
      id: "auth",
      title: "Auth 报表",
      desc: "用户注册、登录、认证事件统计",
      icon: Shield,
      color: "text-green-600 bg-green-500/10",
      href: "auth",
    },
    {
      id: "storage",
      title: "Storage 报表",
      desc: "文件上传下载量、存储空间使用统计",
      icon: HardDrive,
      color: "text-teal-600 bg-teal-500/10",
      href: "storage",
    },
    {
      id: "advisors",
      title: "性能顾问",
      desc: "数据库性能优化建议和安全审计",
      icon: TrendingUp,
      color: "text-pink-600 bg-pink-500/10",
      href: "advisors",
    },
    {
      id: "database-linter",
      title: "数据库检查",
      desc: "表结构、索引、RLS 策略的健康检查",
      icon: BarChart3,
      color: "text-orange-600 bg-orange-500/10",
      href: "database-linter",
    },
  ];
</script>

<div class="h-full flex flex-col space-y-4">
  <div>
    <h1 class="text-2xl font-bold">报表与分析</h1>
    <p class="text-sm text-muted-foreground mt-1">查看项目各服务的使用统计、性能指标和优化建议</p>
  </div>

  <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
    {#each REPORT_SECTIONS as section}
      <a href={`/project/${projectRef}/reports/${section.href}`}
        class="rounded-xl border bg-card hover:border-brand/40 hover:shadow-md transition-all p-5 group cursor-pointer block">
        <div class="flex items-center gap-3 mb-3">
          <div class="w-10 h-10 rounded-lg {section.color} flex items-center justify-center group-hover:scale-110 transition-transform">
            <section.icon size={20} />
          </div>
        </div>
        <h3 class="font-semibold text-sm flex items-center gap-2">
          {section.title}
          <ArrowRight size={14} class="opacity-0 group-hover:opacity-100 transition-opacity text-brand" />
        </h3>
        <p class="text-[10px] text-muted-foreground mt-1 leading-relaxed">{section.desc}</p>
      </a>
    {/each}
  </div>

  <div class="rounded-lg border bg-blue-500/5 border-blue-500/20 p-3 flex items-start gap-2">
    <BarChart3 size={14} class="text-blue-600 mt-0.5 shrink-0" />
    <p class="text-xs text-blue-700">报表数据来源于 PostgreSQL 内部统计视图（如 <code class="bg-blue-500/10 px-1 rounded">pg_stat_statements</code>、<code class="bg-blue-500/10 px-1 rounded">pg_stat_user_tables</code>）和 systemd 日志。部分统计需要启用对应扩展。</p>
  </div>
</div>
