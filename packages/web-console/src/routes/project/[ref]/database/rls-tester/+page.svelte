<script lang="ts">
  import { page } from "$app/state";
  import { apiClient } from "$lib/api";
  import { t } from "svelte-i18n";
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
      if (!response.ok) throw new Error(body.message || $t("RlsTester.run_failed"));
      result = body as TestResult;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : $t("RlsTester.run_failed"));
    } finally {
      running = false;
    }
  }
</script>

<svelte:head><title>{$t("RlsTester.page_title")}</title></svelte:head>

<div class="space-y-5 pb-10">
  <div>
    <div class="flex items-center gap-2">
      <FlaskConical size={22} class="text-brand" />
      <h1 class="text-2xl font-bold">{$t("RlsTester.title")}</h1>
      <span class="rounded bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-700">{$t("RlsTester.experimental")}</span>
    </div>
    <p class="mt-1 text-sm text-muted-foreground">{$t("RlsTester.subtitle")}</p>
  </div>

  <section class="space-y-4 rounded-xl border bg-card p-5">
    <div class="grid gap-4 md:grid-cols-3">
      <label class="space-y-1 text-sm">
        <span class="font-medium">{$t("RlsTester.role")}</span>
        <select bind:value={role} class="h-10 w-full rounded-md border bg-background px-3">
          <option value="anon">{$t("RlsTester.role_anon")}</option>
          <option value="authenticated">{$t("RlsTester.role_authenticated")}</option>
        </select>
      </label>
      {#if role === "authenticated"}
        <label class="space-y-1 text-sm">
          <span class="font-medium">{$t("RlsTester.user_id")}</span>
          <input bind:value={userId} class="h-10 w-full rounded-md border bg-background px-3 font-mono" placeholder="00000000-..." />
        </label>
        <label class="space-y-1 text-sm">
          <span class="font-medium">{$t("RlsTester.email_optional")}</span>
          <input bind:value={email} type="email" class="h-10 w-full rounded-md border bg-background px-3" placeholder="user@example.com" />
        </label>
      {/if}
    </div>
    <label class="block space-y-1 text-sm">
      <span class="font-medium">{$t("RlsTester.read_only_sql")}</span>
      <textarea bind:value={query} rows="8" class="w-full rounded-md border bg-background p-3 font-mono text-xs" spellcheck="false"></textarea>
    </label>
    <div class="flex items-center justify-between gap-3">
      <p class="text-xs text-muted-foreground">{$t("RlsTester.read_only_note")}</p>
      <button onclick={runTest} disabled={running || !query.trim()} class="inline-flex h-9 items-center gap-2 rounded-md bg-brand px-4 text-sm font-medium text-white disabled:opacity-50">
        {#if running}<Loader2 size={15} class="animate-spin" />{:else}<Play size={15} />{/if}
        {$t("RlsTester.run")}
      </button>
    </div>
  </section>

  {#if result}
    <section class="space-y-3 rounded-xl border bg-card p-5">
      <div class="flex items-center justify-between">
        <h2 class="font-semibold">{$t("RlsTester.query_result")}</h2>
        <span class="text-xs text-muted-foreground">{$t("RlsTester.row_count", { values: { count: result.rowCount } })}{result.truncated ? $t("RlsTester.row_limit") : ""}</span>
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
      <div class="flex items-center gap-2"><ShieldCheck size={18} class="text-brand" /><h2 class="font-semibold">{$t("RlsTester.policy_evaluation")}</h2></div>
      <p class="text-xs text-muted-foreground">{$t("RlsTester.query_relations")}：{result.relations.map((relation) => `${relation.schema}.${relation.table}`).join(", ") || $t("RlsTester.no_table_relations")}</p>
      {#if result.policies.length === 0}
        <div class="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{$t("RlsTester.no_policies")}</div>
      {:else}
        <div class="space-y-2">
          {#each result.policies as policy (`${policy.schema}.${policy.table}.${policy.name}`)}
            <article class="rounded-lg border p-3">
              <div class="flex items-center justify-between gap-2">
                <code class="text-xs font-semibold">{policy.schema}.{policy.table} / {policy.name}</code>
                <span class={`rounded px-2 py-0.5 text-[10px] font-bold ${policy.appliesToRole ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground"}`}>{policy.appliesToRole ? $t("RlsTester.applies") : $t("RlsTester.not_applicable")}</span>
              </div>
              <div class="mt-2 grid gap-2 text-xs md:grid-cols-2">
                <div><span class="text-muted-foreground">{$t("RlsTester.using")}</span><pre class="mt-1 overflow-auto rounded bg-muted/40 p-2">{policy.using || "—"}</pre></div>
                <div><span class="text-muted-foreground">{$t("RlsTester.with_check")}</span><pre class="mt-1 overflow-auto rounded bg-muted/40 p-2">{policy.check || "—"}</pre></div>
              </div>
            </article>
          {/each}
        </div>
      {/if}
    </section>
  {/if}
</div>
