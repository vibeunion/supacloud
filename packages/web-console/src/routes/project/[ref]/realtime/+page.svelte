<script lang="ts">
  import { onDestroy } from "svelte";
  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { Loader2, Radio, Send, Trash2, Wifi, WifiOff, Hash, Database, Users, Zap, Megaphone } from "lucide-svelte";
  import { createQuery } from "@tanstack/svelte-query";
  import { apiClient } from "$lib/api";

  interface RealtimeMessage {
    id: number;
    timestamp: string;
    channel: string;
    event: string;
    payload: string;
    type: "broadcast" | "presence" | "postgres_changes" | "system";
  }

  let messages = $state<RealtimeMessage[]>([]);
  let isConnected = $state(false);
  let channelName = $state("*");
  let filterEvent = $state("");
  let ws: WebSocket | null = null;
  let msgId = 0;

  // Subscription mode
  let subMode = $state<"all" | "broadcast" | "postgres_changes" | "presence">("all");
  let pgTable = $state("*");
  let pgEvent = $state<"*" | "INSERT" | "UPDATE" | "DELETE">("*");
  let broadcastEvent = $state("test");
  let broadcastPayload = $state('{"message": "hello"}');

  const projectRef = $derived(page.params.ref);

  const projectQuery = createQuery(() => ({
    queryKey: ["v1/projects", "getOne", projectRef],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}`);
      if (!res.ok) throw new Error("Failed to fetch project details");
      return res.json();
    }
  }));
  const project = $derived(projectQuery.data);

  const filteredMessages = $derived(
    filterEvent
      ? messages.filter(m => m.event.toLowerCase().includes(filterEvent.toLowerCase()))
      : messages
  );

  function connectWebSocket() {
    if (ws) ws.close();

    const anonKey = project?.anon_key;
    if (!anonKey) {
        addSystemMessage("连接异常: Missing tenant anon_key. Project might still be loading.");
        return;
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.hostname;
    // Connect through the management-api proxy using ?apikey.
    // In local dev, Management API lives on port 3000 mapping to proxy.
    const wsUrl = `${protocol}//${host}:3000/realtime/v1/websocket?apikey=${anonKey}&vsn=1.0.0`;

    try {
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        isConnected = true;
        addSystemMessage("已连接到 Realtime 服务");

        // Join channel based on mode
        const joinPayload: Record<string, unknown> = {};
        if (subMode === "postgres_changes" || subMode === "all") {
          joinPayload.config = {
            postgres_changes: [{ event: pgEvent, schema: "public", table: pgTable === "*" ? undefined : pgTable }]
          };
        }

        ws?.send(JSON.stringify({
          topic: `realtime:${channelName}`,
          event: "phx_join",
          payload: joinPayload,
          ref: String(++msgId)
        }));
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          const typeName = inferType(data) as RealtimeMessage["type"];
          messages = [{
            id: ++msgId,
            timestamp: new Date().toLocaleTimeString("zh-CN"),
            channel: data.topic || channelName,
            event: data.event || "unknown",
            payload: JSON.stringify(data.payload || {}, null, 2),
            type: typeName,
          }, ...messages].slice(0, 200);
        } catch {
          messages = [{
            id: ++msgId,
            timestamp: new Date().toLocaleTimeString("zh-CN"),
            channel: channelName,
            event: "RAW",
            payload: event.data,
            type: "system" as const,
          }, ...messages].slice(0, 200);
        }
      };

      ws.onclose = () => {
        isConnected = false;
        addSystemMessage("连接已断开");
      };

      ws.onerror = () => {
        isConnected = false;
        addSystemMessage("连接失败 — Realtime 服务可能未启动，请在「设置 → 服务控制」中检查");
      };
    } catch (err: unknown) {
      addSystemMessage(`连接异常: ${(err instanceof Error ? err.message : String(err))}`);
    }
  }

  function disconnectWebSocket() {
    if (ws) { ws.close(); ws = null; }
  }

  function addSystemMessage(text: string) {
    messages = [{
      id: ++msgId,
      timestamp: new Date().toLocaleTimeString("zh-CN"),
      channel: "-",
      event: "SYSTEM",
      payload: text,
      type: "system",
    }, ...messages];
  }

  function inferType(data: unknown): RealtimeMessage["type"] {
    const d = data as Record<string, unknown>;
    if (d.event === "phx_reply" || d.event === "phx_close" || d.event === "heartbeat") return "system";
    if (d.event === "broadcast") return "broadcast";
    if (d.event === "presence_diff" || d.event === "presence_state") return "presence";
    if ((d.payload as Record<string, unknown>)?.type === "INSERT" || (d.payload as Record<string, unknown>)?.type === "UPDATE" || (d.payload as Record<string, unknown>)?.type === "DELETE") return "postgres_changes";
    return "system";
  }

  function sendBroadcast() {
    if (!ws || !isConnected) return;
    try {
      const payload = JSON.parse(broadcastPayload);
      ws.send(JSON.stringify({
        topic: `realtime:${channelName}`,
        event: "broadcast",
        payload: { type: "broadcast", event: broadcastEvent, payload },
        ref: String(++msgId)
      }));
      addSystemMessage(`已发送 Broadcast: ${broadcastEvent}`);
    } catch (err: unknown) {
      addSystemMessage(`发送失败: ${(err instanceof Error ? err.message : String(err))}`);
    }
  }

  function clearMessages() { messages = []; }

  function getTypeColor(type: string): string {
    if (type === "broadcast") return "text-blue-600 bg-blue-500/10";
    if (type === "presence") return "text-violet-600 bg-violet-500/10";
    if (type === "postgres_changes") return "text-green-600 bg-green-500/10";
    return "text-muted-foreground bg-muted/30";
  }

  function getTypeIcon(type: string) {
    if (type === "broadcast") return Megaphone;
    if (type === "presence") return Users;
    if (type === "postgres_changes") return Database;
    return Radio;
  }

  onDestroy(() => { if (ws) ws.close(); });
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">Realtime Inspector</h1>
      <p class="text-sm text-muted-foreground mt-1">监控和调试 Realtime 频道消息</p>
    </div>
    <div class="flex items-center gap-2">
      <span class="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold {isConnected ? 'bg-green-500/10 text-green-600 border border-green-500/30' : 'bg-muted text-muted-foreground border'}">
        {#if isConnected}<Wifi size={10} />{:else}<WifiOff size={10} />{/if}
        {isConnected ? "已连接" : "未连接"}
      </span>
    </div>
  </div>

  <!-- Connection Config -->
  <div class="rounded-xl border bg-card p-4 space-y-3">
    <div class="grid grid-cols-1 md:grid-cols-4 gap-3">
      <div>
        <span class="text-[10px] font-semibold text-muted-foreground uppercase">频道名称</span>
        <input type="text" bind:value={channelName}
          class="w-full mt-1 px-3 py-1.5 text-xs font-mono rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand" />
      </div>
      <div>
        <span class="text-[10px] font-semibold text-muted-foreground uppercase">订阅模式</span>
        <select bind:value={subMode}
          class="w-full mt-1 px-3 py-1.5 text-xs rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand">
          <option value="all">全部</option>
          <option value="postgres_changes">DB Changes</option>
          <option value="broadcast">Broadcast</option>
          <option value="presence">Presence</option>
        </select>
      </div>
      {#if subMode === "postgres_changes" || subMode === "all"}
        <div>
          <span class="text-[10px] font-semibold text-muted-foreground uppercase">监听表</span>
          <input type="text" bind:value={pgTable} placeholder="* (所有表)"
            class="w-full mt-1 px-3 py-1.5 text-xs font-mono rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand" />
        </div>
        <div>
          <span class="text-[10px] font-semibold text-muted-foreground uppercase">事件类型</span>
          <select bind:value={pgEvent}
            class="w-full mt-1 px-3 py-1.5 text-xs rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand">
            <option value="*">全部</option>
            <option value="INSERT">INSERT</option>
            <option value="UPDATE">UPDATE</option>
            <option value="DELETE">DELETE</option>
          </select>
        </div>
      {/if}
    </div>

    <div class="flex items-center gap-2">
      {#if isConnected}
        <button onclick={disconnectWebSocket}
          class="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg border border-destructive text-destructive hover:bg-destructive/10 transition-colors">
          <WifiOff size={12} /> 断开连接
        </button>
      {:else}
        <button onclick={connectWebSocket}
          class="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors">
          <Wifi size={12} /> 连接
        </button>
      {/if}
      <button onclick={clearMessages} class="flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg border hover:bg-muted/50 transition-colors">
        <Trash2 size={12} /> 清空
      </button>
    </div>
  </div>

  <!-- Broadcast Send -->
  {#if isConnected && (subMode === "broadcast" || subMode === "all")}
    <div class="rounded-xl border bg-blue-500/5 border-blue-500/20 p-3 flex items-end gap-3">
      <div class="flex-1 grid grid-cols-2 gap-2">
        <div>
          <span class="text-[9px] font-semibold text-blue-600 uppercase">Broadcast 事件名</span>
          <input type="text" bind:value={broadcastEvent}
            class="w-full mt-0.5 px-2 py-1 text-xs font-mono rounded border bg-background focus:outline-none focus:ring-1 focus:ring-brand" />
        </div>
        <div>
          <span class="text-[9px] font-semibold text-blue-600 uppercase">Payload (JSON)</span>
          <input type="text" bind:value={broadcastPayload}
            class="w-full mt-0.5 px-2 py-1 text-xs font-mono rounded border bg-background focus:outline-none focus:ring-1 focus:ring-brand" />
        </div>
      </div>
      <button onclick={sendBroadcast}
        class="flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors shrink-0">
        <Send size={12} /> 发送
      </button>
    </div>
  {/if}

  <!-- Messages -->
  <div class="flex-1 rounded-xl border bg-card overflow-hidden flex flex-col min-h-0">
    <div class="border-b px-4 py-2 bg-muted/20 flex items-center justify-between flex-shrink-0">
      <h2 class="text-xs font-semibold flex items-center gap-2"><Radio size={12} /> 消息日志 <span class="text-muted-foreground">({messages.length})</span></h2>
      <input type="text" bind:value={filterEvent} placeholder="筛选事件..."
        class="px-2 py-1 text-[10px] rounded border bg-background w-40 focus:outline-none focus:ring-1 focus:ring-brand" />
    </div>
    <div class="flex-1 overflow-auto">
      {#if filteredMessages.length === 0}
        <div class="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2 opacity-30">
          <Radio size={32} />
          <p class="text-xs">{isConnected ? "等待消息..." : "点击「连接」开始监听"}</p>
        </div>
      {:else}
        <table class="w-full text-xs">
          <thead class="bg-muted/20 sticky top-0">
            <tr>
              <th class="px-3 py-1.5 text-left font-semibold text-muted-foreground w-20">时间</th>
              <th class="px-3 py-1.5 text-left font-semibold text-muted-foreground w-24">类型</th>
              <th class="px-3 py-1.5 text-left font-semibold text-muted-foreground w-32">事件</th>
              <th class="px-3 py-1.5 text-left font-semibold text-muted-foreground">内容</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border/10 font-mono">
            {#each filteredMessages as msg (msg.id)}
              {@const TypeIcon = getTypeIcon(msg.type)}
              <tr class="hover:bg-muted/10 transition-colors">
                <td class="px-3 py-1.5 text-[10px] text-muted-foreground">{msg.timestamp}</td>
                <td class="px-3 py-1.5">
                  <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold {getTypeColor(msg.type)}">
                    <TypeIcon size={9} /> {msg.type}
                  </span>
                </td>
                <td class="px-3 py-1.5 font-semibold text-[11px]">{msg.event}</td>
                <td class="px-3 py-1.5 text-[10px] text-muted-foreground truncate max-w-[400px]" title={msg.payload}>{msg.payload}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>
  </div>
</div>
