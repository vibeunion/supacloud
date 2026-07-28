<script lang="ts">
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import { t } from "svelte-i18n";
import { Users, Package, Zap, Braces, Hash, FolderOpen, CalendarClock, Radio, Webhook, GitCommitVertical, Tag, ShieldCheck, HardDrive, Globe, Settings, Layers, FlaskConical, KeyRound, Workflow, ArrowUpCircle } from "lucide-svelte";

  const projectRef = $derived(page.params.ref);

  const subPages = $derived([
    { title: $t("Roles.title"), desc: $t("Roles.subtitle"), icon: Users, href: `/project/${projectRef}/database/roles` },
    { title: $t("Extensions.title"), desc: $t("Extensions.subtitle"), icon: Package, href: `/project/${projectRef}/database/extensions` },
    { title: $t("Triggers.title"), desc: $t("Triggers.subtitle"), icon: Zap, href: `/project/${projectRef}/database/triggers` },
    { title: $t("DbFunctions.title"), desc: $t("DbFunctions.subtitle"), icon: Braces, href: `/project/${projectRef}/database/functions` },
    { title: $t("Indexes.title"), desc: $t("Indexes.subtitle"), icon: Hash, href: `/project/${projectRef}/database/indexes` },
    { title: "物化视图", desc: "缓存复杂查询和聚合结果，按业务新鲜度手动刷新", icon: Layers, href: `/project/${projectRef}/database/materialized-views` },
    { title: $t("Schemas.title"), desc: $t("Schemas.subtitle"), icon: FolderOpen, href: `/project/${projectRef}/database/schemas` },
    { title: $t("EnumTypes.title"), desc: $t("EnumTypes.subtitle"), icon: Tag, href: `/project/${projectRef}/database/types` },
    { title: $t("ColumnPrivileges.title"), desc: $t("ColumnPrivileges.subtitle"), icon: ShieldCheck, href: `/project/${projectRef}/database/column-privileges` },
    { title: "RLS Tester", desc: "以 anon 或 authenticated 身份执行只读查询并查看参与评估的策略", icon: FlaskConical, href: `/project/${projectRef}/database/rls-tester` },
    { title: "临时数据库访问", desc: "按项目成员和数据库角色签发最长 90 天的短期连接凭据", icon: KeyRound, href: `/project/${projectRef}/database/temporary-access` },
    { title: "Pipelines", desc: "使用 Supabase ETL 将 Publication 的初始数据和 CDC 变更同步到 BigQuery", icon: Workflow, href: `/project/${projectRef}/database/pipelines` },
    { title: $t("Publications.title"), desc: $t("Publications.subtitle"), icon: Radio, href: `/project/${projectRef}/database/publications` },
    { title: $t("Hooks.title"), desc: $t("Hooks.subtitle"), icon: Webhook, href: `/project/${projectRef}/database/hooks` },
    { title: $t("Migrations.title"), desc: $t("Migrations.subtitle"), icon: GitCommitVertical, href: `/project/${projectRef}/database/migrations` },
    { title: $t("Backups.title"), desc: $t("Backups.subtitle"), icon: HardDrive, href: `/project/${projectRef}/database/backups` },
    { title: $t("CronJobs.title"), desc: $t("CronJobs.subtitle"), icon: CalendarClock, href: `/project/${projectRef}/database/cron` },
    { title: "Wrappers (FDW)", desc: "连接外部数据源，在 SQL 中查询第三方服务", icon: Globe, href: `/project/${projectRef}/database/wrappers` },
    { title: "数据库设置", desc: "PostgreSQL 运行时参数和性能配置", icon: Settings, href: `/project/${projectRef}/database/settings` },
    { title: "PostgreSQL 大版本升级", desc: "集群级预检、全量备份、审批、校验与回滚工作流", icon: ArrowUpCircle, href: `/project/${projectRef}/database/upgrade` },
  ]);
</script>

<div class="h-full flex flex-col space-y-6">
  <div>
    <h1 class="text-2xl font-bold">{$t("Navigation.database")}</h1>
    <p class="text-sm text-muted-foreground mt-1">管理你的 PostgreSQL 数据库对象和配置</p>
  </div>

  <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
    {#each subPages as item (item.href)}
      <a
        href={resolve(item.href as "/")}
        class="p-5 rounded-xl border bg-card hover:bg-secondary/50 hover:border-brand/30 transition-all cursor-pointer group block no-underline"
      >
        <div class="flex items-center gap-3 mb-2">
          <div class="w-8 h-8 rounded-lg bg-brand/10 text-brand flex items-center justify-center group-hover:bg-brand/20 transition-colors">
            <item.icon size={16} />
          </div>
          <span class="font-semibold text-sm group-hover:text-brand transition-colors">{item.title}</span>
        </div>
        <p class="text-xs text-muted-foreground leading-relaxed pl-11">{item.desc}</p>
      </a>
    {/each}
  </div>
</div>
