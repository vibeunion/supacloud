<script lang="ts">
  import { page } from "$app/state";
  import { apiClient } from "$lib/api";
  import { FlaskConical, Loader2, Play, ShieldCheck } from "lucide-svelte";
  import { toast } from "svelte-sonner";

  type Policy = {
    schema: string;
    table: string;
    name: string;
    command: string;
    using: string | null;
    check: string | null;
    appliesToRole: boolean;
  };

  type TestResult = {
    rows: Array<Record<string, unknown>>;
    fields: string[];
    rowCount: number;
    truncated: boolean;
    policies: Policy[];
    relations: Array<{ schema: string; table: string }>;
  };

  const projectRef = $derived(page.params.ref);
  let query = $state("select * from public.todos limit 20");
  let role = $state<"anon" | "authenticated">("anon");
  let userId = $state("");
  let email = $state("");
  let running = $state(false);
  let result = $state<TestResult | null>(null);

  async function runTest() {
    running = true;
    try {
      const response = await apiClient(`/v1/projects/${projectRef}/database/rls-test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          role,
          ...(role === "authenticated" && userId ? { user_id: userId } : {}),
          ...(role === "authenticated" && email ? { email } : {}),
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || "RLS 测试失败");
      result = body as TestResult;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "RLS 测试失败");
    } finally {
      running = false;
    }
  }
</script>

<svelte:head><title>RLS Tester · SupaCloud</title></svelte:head>

<div class="space-y-5 pb-10">
  <div>
    <div class="flex items-center gap-2">
      <FlaskConical size={22} class="text-brand" />
      <h1 class="text-2xl font-bold">RLS Tester</h1>
      <span class="rounded bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-700">Experimental</span>
    </div>
    <p class="mt-1 text-sm text-muted-foreground">模拟 Data API 角色执行 SELECT，检查返回行和参与评估的 RLS 策略。</p>
  </div>

  <section class="space-y-4 rounded-xl border bg-card p-5">
    <div class="grid gap-4 md:grid-cols-3">
      <label class="space-y-1 text-sm">
        <span class="font-medium">角色</span>
        <select bind:value={role} class="h-10 w-full rounded-md border bg-background px-3">
          <option value="anon">anon（未登录）</option>
          <option value="authenticated">authenticated（已登录）</option>
        </select>
      </label>
      {#if role === "authenticated"}
        <label class="space-y-1 text-sm">
          <span class="font-medium">用户 ID（UUID）</span>
          <input bind:value={userId} class="h-10 w-full rounded-md border bg-background px-3 font-mono" placeholder="00000000-..." />
        </label>
        <label class="space-y-1 text-sm">
          <span class="font-medium">Email（可选）</span>
          <input bind:value={email} type="email" class="h-10 w-full rounded-md border bg-background px-3" placeholder="user@example.com" />
        </label>
      {/if}
    </div>
    <label class="block space-y-1 text-sm">
      <span class="font-medium">只读 SQL</span>
      <textarea bind:value={query} rows="8" class="w-full rounded-md border bg-background p-3 font-mono text-xs" spellcheck="false"></textarea>
    </label>
    <div class="flex items-center justify-between gap-3">
      <p class="text-xs text-muted-foreground">仅允许单条 SELECT/WITH；使用 READ ONLY 事务、硬超时和结果上限，并阻止已知高风险调用。</p>
      <button onclick={runTest} disabled={running || !query.trim()} class="inline-flex h-9 items-center gap-2 rounded-md bg-brand px-4 text-sm font-medium text-white disabled:opacity-50">
        {#if running}<Loader2 size={15} class="animate-spin" />{:else}<Play size={15} />{/if}
        运行测试
      </button>
    </div>
  </section>

  {#if result}
    <section class="space-y-3 rounded-xl border bg-card p-5">
      <div class="flex items-center justify-between">
        <h2 class="font-semibold">查询结果</h2>
        <span class="text-xs text-muted-foreground">{result.rowCount} 行{result.truncated ? "（最多显示 500 行）" : ""}</span>
      </div>
      <div class="overflow-auto rounded-lg border">
        <table class="min-w-full text-left text-xs">
          <thead class="bg-muted/50">
            <tr>{#each result.fields as field (field)}<th class="whitespace-nowrap px-3 py-2 font-medium">{field}</th>{/each}</tr>
          </thead>
          <tbody class="divide-y">
            {#each result.rows as row, rowIndex (`${rowIndex}:${JSON.stringify(row)}`)}
              <tr>{#each result.fields as field (field)}<td class="max-w-80 truncate px-3 py-2 font-mono">{JSON.stringify(row[field])}</td>{/each}</tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <section class="space-y-3 rounded-xl border bg-card p-5">
      <div class="flex items-center gap-2"><ShieldCheck size={18} class="text-brand" /><h2 class="font-semibold">策略评估</h2></div>
      <p class="text-xs text-muted-foreground">查询关系：{result.relations.map((relation) => `${relation.schema}.${relation.table}`).join(", ") || "无表关系"}</p>
      {#if result.policies.length === 0}
        <div class="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">查询计划涉及的表没有 RLS 策略。</div>
      {:else}
        <div class="space-y-2">
          {#each result.policies as policy (`${policy.schema}.${policy.table}.${policy.name}`)}
            <article class="rounded-lg border p-3">
              <div class="flex items-center justify-between gap-2">
                <code class="text-xs font-semibold">{policy.schema}.{policy.table} / {policy.name}</code>
                <span class={`rounded px-2 py-0.5 text-[10px] font-bold ${policy.appliesToRole ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground"}`}>{policy.appliesToRole ? "适用于当前角色" : "不适用"}</span>
              </div>
              <div class="mt-2 grid gap-2 text-xs md:grid-cols-2">
                <div><span class="text-muted-foreground">USING</span><pre class="mt-1 overflow-auto rounded bg-muted/40 p-2">{policy.using || "—"}</pre></div>
                <div><span class="text-muted-foreground">WITH CHECK</span><pre class="mt-1 overflow-auto rounded bg-muted/40 p-2">{policy.check || "—"}</pre></div>
              </div>
            </article>
          {/each}
        </div>
      {/if}
    </section>
  {/if}
</div>
