<script lang="ts">
  import { page } from "$app/state";
  import { apiClient } from "$lib/api";
  import { createMutation, createQuery } from "@tanstack/svelte-query";
  import { Cpu, HardDrive, Loader2, Plus, RefreshCw, Server, Trash2 } from "lucide-svelte";
  import { toast } from "svelte-sonner";

  interface ComputeTier {
    tier: string;
    cpu: number;
    memory: string;
  }

  interface ReadReplica {
    id: string;
    ip: string;
    region: string;
    status: string;
    created_at: string;
    updated_at: string;
    last_error?: string;
  }

  interface ScalingState {
    success: boolean;
    tiers: ComputeTier[];
    compute: {
      tier: string;
      status: string;
      cpu: number;
      memory: string;
      updated_at: string;
      last_error?: string;
    };
    read_replicas: ReadReplica[];
  }

  const projectRef = $derived(page.params.ref);

  let targetTier = $state("pro");
  let replicaIp = $state("");
  let replicaRegion = $state("local");

  const scalingQuery = createQuery(() => ({
    queryKey: ["project-scaling", projectRef],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/scaling`);
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.message || data.error || "Failed to load scaling state");
      return data as ScalingState;
    }
  }));

  const computeMutation = createMutation(() => ({
    mutationFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/scaling/compute`, {
        method: "POST",
        body: JSON.stringify({ target_tier: targetTier })
      });
      const data = await res.json();
      if (!res.ok || data.error || data.success === false) throw new Error(data.message || data.error || "Failed to upgrade compute");
      return data;
    },
    onSuccess: () => {
      toast.success("Compute 调整已执行");
      scalingQuery.refetch();
    }
  }));

  const replicaMutation = createMutation(() => ({
    mutationFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/read-replicas`, {
        method: "POST",
        body: JSON.stringify({ replica_ip: replicaIp, region: replicaRegion })
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.message || data.error || "Failed to create read replica");
      return data;
    },
    onSuccess: () => {
      toast.success("读副本已登记");
      replicaIp = "";
      scalingQuery.refetch();
    }
  }));

  const deleteReplicaMutation = createMutation(() => ({
    mutationFn: async (replica: ReadReplica) => {
      const res = await apiClient(`/v1/projects/${projectRef}/read-replicas/${replica.id}`, {
        method: "DELETE"
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.message || data.error || "Failed to delete read replica");
      return data;
    },
    onSuccess: () => {
      toast.success("读副本已移除");
      scalingQuery.refetch();
    }
  }));

  const scalingState = $derived(scalingQuery.data as ScalingState | undefined);
  const tiers = $derived(scalingState?.tiers || []);
  const replicas = $derived(scalingState?.read_replicas || []);
  const error = $derived(
    scalingQuery.error?.message ||
    computeMutation.error?.message ||
    replicaMutation.error?.message ||
    deleteReplicaMutation.error?.message ||
    null
  );
</script>

<div class="h-full flex flex-col space-y-4">
  <div>
    <h2 class="text-xl font-bold">扩展/副本</h2>
    <p class="text-sm text-muted-foreground mt-1">调整项目 compute 档位，登记只读副本并接入读流量入口。</p>
  </div>

  {#if scalingQuery.isPending}
    <div class="flex-1 flex items-center justify-center">
      <Loader2 size={32} class="animate-spin text-brand opacity-60" />
    </div>
  {:else}
    {#if error}
      <div class="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
    {/if}

    <div class="grid gap-4 lg:grid-cols-2">
      <div class="rounded-xl border bg-card overflow-hidden">
        <div class="border-b px-5 py-4 flex items-center justify-between">
          <h3 class="font-semibold text-sm flex items-center gap-2"><Cpu size={16} /> Compute</h3>
          <button onclick={() => scalingQuery.refetch()} class="p-2 rounded-md border hover:bg-muted/50" title="刷新">
            <RefreshCw size={14} />
          </button>
        </div>
        <div class="p-5 space-y-4">
          <div class="grid grid-cols-3 gap-3">
            <div class="rounded-lg border bg-muted/20 p-3">
              <div class="text-[10px] text-muted-foreground uppercase font-bold">Tier</div>
              <div class="mt-1 font-mono text-lg">{scalingState?.compute.tier || "micro"}</div>
            </div>
            <div class="rounded-lg border bg-muted/20 p-3">
              <div class="text-[10px] text-muted-foreground uppercase font-bold">CPU</div>
              <div class="mt-1 font-mono text-lg">{scalingState?.compute.cpu || 1}</div>
            </div>
            <div class="rounded-lg border bg-muted/20 p-3">
              <div class="text-[10px] text-muted-foreground uppercase font-bold">Memory</div>
              <div class="mt-1 font-mono text-lg">{scalingState?.compute.memory || "2g"}</div>
            </div>
          </div>

          <div class="flex flex-wrap gap-2">
            {#each tiers as tier (tier.tier)}
              <button
                onclick={() => { targetTier = tier.tier; }}
                class="px-3 py-2 rounded-md border text-sm font-medium {targetTier === tier.tier ? 'bg-brand text-white border-brand' : 'hover:bg-muted/50'}"
              >
                {tier.tier}
                <span class="block text-[10px] opacity-75">{tier.cpu} CPU · {tier.memory}</span>
              </button>
            {/each}
          </div>

          <button
            onclick={() => computeMutation.mutate()}
            disabled={computeMutation.isPending || !targetTier}
            class="flex items-center justify-center gap-2 px-4 py-2 rounded-md bg-brand text-white text-sm font-medium disabled:opacity-50"
          >
            {#if computeMutation.isPending}
              <Loader2 size={14} class="animate-spin" />
            {:else}
              <HardDrive size={14} />
            {/if}
            应用档位
          </button>
        </div>
      </div>

      <div class="rounded-xl border bg-card overflow-hidden">
        <div class="border-b px-5 py-4">
          <h3 class="font-semibold text-sm flex items-center gap-2"><Server size={16} /> 读副本</h3>
        </div>
        <div class="p-5 space-y-4">
          <form class="flex flex-col sm:flex-row gap-2" onsubmit={(event) => { event.preventDefault(); replicaMutation.mutate(); }}>
            <input bind:value={replicaIp} class="flex-1 px-3 py-2 rounded-md border bg-background text-sm font-mono" placeholder="10.10.10.12" />
            <input bind:value={replicaRegion} class="w-full sm:w-32 px-3 py-2 rounded-md border bg-background text-sm font-mono" placeholder="local" />
            <button disabled={replicaMutation.isPending || !replicaIp.trim()} class="px-4 py-2 rounded-md bg-brand text-white text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2">
              {#if replicaMutation.isPending}
                <Loader2 size={14} class="animate-spin" />
              {:else}
                <Plus size={14} />
              {/if}
              添加
            </button>
          </form>

          {#if replicas.length === 0}
            <div class="h-40 flex items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
              暂无读副本
            </div>
          {:else}
            <div class="space-y-2">
              {#each replicas as replica (replica.id)}
                <div class="flex items-center justify-between gap-3 rounded-lg border p-3">
                  <div class="min-w-0">
                    <div class="font-mono text-sm truncate">{replica.ip}</div>
                    <div class="text-[11px] text-muted-foreground">{replica.region} · {replica.status}</div>
                    {#if replica.last_error}
                      <div class="text-[11px] text-destructive truncate">{replica.last_error}</div>
                    {/if}
                  </div>
                  <button onclick={() => deleteReplicaMutation.mutate(replica)} class="p-2 rounded-md border text-destructive hover:bg-destructive/10" title="移除">
                    <Trash2 size={14} />
                  </button>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      </div>
    </div>
  {/if}
</div>
