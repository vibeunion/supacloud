import type { RealtimeBunService } from "./realtime-bun.service";
import type { ResolvedProjectApiKey } from "../utils/project-auth";
import { isRecord } from "../utils/project-config";
import {
  parsePostgresChangeSubscriptions, parseRealtimeChange, canUseNativeRealtimeSubscriptions,
  bindRealtimeSubscriptionIds, projectRealtimeChangeEvents, type ChangeEvent, type PostgresChangeConfig,
} from "../utils/realtime-change";
import {
  encodePhoenixMessage, parsePhoenixMessage, realtimeBinary, isPhoenixBroadcastFrame, MAX_REALTIME_FRAME_BYTES,
  type PhoenixMessage, type PhoenixVersion,
} from "../utils/phoenix-message";
import { logger } from "../utils/logger";

type Frame = string | Uint8Array<ArrayBuffer>;
export interface RealtimeClientTransport {
  send(data: Frame): unknown;
  close(code?: number, reason?: string): unknown;
}
export interface RealtimeUpstreamTransport extends RealtimeClientTransport {
  readonly readyState: number;
}
export interface RealtimeUpstreamCallbacks {
  open(): void;
  message(data: unknown): void;
  close(): void;
  error(): void;
}
type NativeBackend = Pick<RealtimeBunService,
  "subscribeTenant" | "unsubscribeSubscription" | "registerSubscriptionIds" | "updateSubscriptionToken" | "events">;
export interface RealtimeProxyDependencies {
  resolveKey(key: string): Promise<ResolvedProjectApiKey | null>;
  connect(projectRef: string, key: string, version: PhoenixVersion, callbacks: RealtimeUpstreamCallbacks): RealtimeUpstreamTransport;
  backend: NativeBackend;
  schedule?: (callback: () => void, milliseconds: number) => () => void;
}
interface Channel {
  join: PhoenixMessage;
  changes: PostgresChangeConfig[];
  token: string;
  nativeId?: string;
  handler?: (event: ChangeEvent) => void;
  ready: Promise<boolean>;
  joined: boolean;
  refreshVersion: number;
  refreshing: boolean;
  serverIds: Array<string | number>;
  bindings: PostgresChangeConfig[];
  native: boolean;
  controller: AbortController;
  cancelJoinTimeout?: () => void;
}

export const MAX_CONNECTIONS_PER_PROJECT = 200;
const MAX_BUFFERED_FRAMES = 256;
export const REALTIME_DEADLINES = { authentication: 10_000, connection: 10_000, join: 15_000, refresh: 10_000 };
const connectionCounts = new Map<string, number>();
export function realtimeProjectConnections(): Map<string, number> { return new Map(connectionCounts); }

export class RealtimeProxySession {
  private closed = false;
  private projectRef: string | undefined;
  private apiKey = "";
  private presentedApiKey = "";
  private version: PhoenixVersion = "2.0.0";
  private upstream: RealtimeUpstreamTransport | undefined;
  private buffered: Array<{ data: Frame; topic?: string }> = [];
  private bufferedBytes = 0;
  private channels = new Map<string, Channel>();
  private earlyMessages: Frame[] = [];
  private earlyBytes = 0;
  private cancelConnectionTimeout: (() => void) | undefined;
  private operations = new Set<() => void>();

  constructor(
    private readonly client: RealtimeClientTransport,
    private readonly dependencies: RealtimeProxyDependencies,
  ) {}

  async open(request: Request): Promise<void> {
    try {
      const query = new URL(request.url).searchParams;
      const apiKey = query.get("apikey");
      const version = query.get("vsn") ?? "2.0.0";
      if (!apiKey || query.getAll("apikey").length !== 1 || query.getAll("ref").length > 1
        || query.getAll("vsn").length > 1 || (version !== "1.0.0" && version !== "2.0.0")) {
        this.close(1008, "Invalid Realtime connection parameters");
        return;
      }
      this.version = version;
      const resolved = await this.withDeadline(this.dependencies.resolveKey(apiKey), REALTIME_DEADLINES.authentication);
      if (this.closed) return;
      if (!resolved?.ref || !resolved.upstreamKey) { this.close(1008, "Invalid apikey"); return; }
      for (const requested of [query.get("ref"), request.headers.get("x-project-ref"), request.headers.get("x-supabase-project")]) {
        if (requested && requested !== resolved.ref) {
          this.close(1008, "Project reference does not match apikey");
          return;
        }
      }
      const count = connectionCounts.get(resolved.ref) ?? 0;
      if (count >= MAX_CONNECTIONS_PER_PROJECT) { this.close(1008, "Realtime connection limit reached"); return; }
      this.projectRef = resolved.ref;
      this.apiKey = resolved.upstreamKey;
      this.presentedApiKey = apiKey;
      connectionCounts.set(resolved.ref, count + 1);
      this.cancelConnectionTimeout = this.schedule(() => this.close(1011, "Upstream connection timed out"), REALTIME_DEADLINES.connection);
      this.upstream = this.dependencies.connect(resolved.ref, resolved.upstreamKey, version, {
        open: () => { this.cancelConnectionTimeout?.(); this.cancelConnectionTimeout = undefined; this.flush(); },
        message: (data) => { void this.receiveUpstream(data).catch(() => this.close(1011, "Invalid upstream response")); },
        close: () => this.close(),
        error: () => this.close(1011, "Upstream connection error"),
      });
      if (this.upstream.readyState === WebSocket.OPEN) {
        this.cancelConnectionTimeout?.();
        this.cancelConnectionTimeout = undefined;
      }
      const earlyMessages = this.earlyMessages;
      this.earlyMessages = [];
      this.earlyBytes = 0;
      for (const message of earlyMessages) await this.message(message);
    } catch {
      this.close(1011, "Proxy initialization fault");
    }
  }

  async message(raw: unknown): Promise<void> {
    if (this.closed) return;
    if (!this.projectRef) {
      const binary = realtimeBinary(raw);
      const message = binary ? null : parsePhoenixMessage(raw);
      if (!binary && !message) { this.close(1008, "Invalid Phoenix message"); return; }
      const frame = binary ?? (message ? encodePhoenixMessage(message, this.version) : "");
      const bytes = this.frameBytes(frame);
      if (this.earlyMessages.length >= MAX_BUFFERED_FRAMES || this.earlyBytes + bytes > MAX_REALTIME_FRAME_BYTES) {
        this.close(1009, "Realtime authentication buffer limit exceeded");
        return;
      }
      this.earlyMessages.push(frame);
      this.earlyBytes += bytes;
      return;
    }
    const binary = realtimeBinary(raw);
    if (binary) {
      if (binary.byteLength > MAX_REALTIME_FRAME_BYTES) this.close(1009, "Realtime frame too large");
      else if (!isPhoenixBroadcastFrame(binary, "client")) this.close(1008, "Invalid binary broadcast");
      else this.forward(binary);
      return;
    }
    const message = parsePhoenixMessage(raw);
    if (!message) { this.close(1008, "Invalid Phoenix message"); return; }
    if (message.payload.access_token === this.presentedApiKey) {
      message.payload = { ...message.payload, access_token: this.apiKey };
    }
    const encoded = encodePhoenixMessage(message, this.version);
    if (Buffer.byteLength(encoded) > MAX_REALTIME_FRAME_BYTES) { this.close(1009, "Realtime frame too large"); return; }

    if (message.event === "heartbeat" && this.upstream?.readyState !== WebSocket.OPEN) {
      this.reply(message, "ok");
      return;
    }
    if (message.event === "phx_leave") {
      this.removeChannel(message.topic);
      if (this.upstream?.readyState !== WebSocket.OPEN) {
        this.buffered = this.buffered.filter((frame) => frame.topic !== message.topic);
        this.bufferedBytes = this.buffered.reduce((sum, frame) => sum + this.frameBytes(frame.data), 0);
        this.reply(message, "ok");
        return;
      }
    }
    if (message.event === "phx_join") {
      const config = message.payload.config;
      if (config !== undefined && !isRecord(config)) { this.reply(message, "error", "Invalid channel config"); return; }
      const rawChanges = isRecord(config) ? config.postgres_changes : undefined;
      const changes = rawChanges === undefined || (Array.isArray(rawChanges) && rawChanges.length === 0)
        ? [] : parsePostgresChangeSubscriptions(rawChanges);
      const token = message.payload.access_token ?? this.apiKey;
      if (!changes || typeof token !== "string" || !token) {
        this.reply(message, "error", "Invalid subscription");
        return;
      }
      if (!this.channels.has(message.topic) && this.channels.size >= 100) {
        this.reply(message, "error", "Channel limit reached");
        return;
      }
      this.removeChannel(message.topic);
      if (this.upstream?.readyState === WebSocket.CONNECTING) {
        this.buffered = this.buffered.filter((frame) => frame.topic !== message.topic);
        this.bufferedBytes = this.buffered.reduce((sum, frame) => sum + this.frameBytes(frame.data), 0);
      }
      const channel: Channel = {
        join: message, changes, token, ready: Promise.resolve(true),
        joined: false, refreshVersion: 0, refreshing: false, serverIds: [],
        bindings: [], native: changes.length > 0 && canUseNativeRealtimeSubscriptions(changes),
        controller: new AbortController(),
      };
      this.channels.set(message.topic, channel);
      channel.cancelJoinTimeout = this.schedule(() => this.failChannel(channel, "Channel join timed out"), REALTIME_DEADLINES.join);
      if (channel.native) channel.ready = this.withDeadline(
        this.startNative(channel), REALTIME_DEADLINES.join, channel.controller.signal,
      ).catch(() => false).then((ready) => {
        if (!ready) this.failChannel(channel, "Native subscription rejected");
        return ready;
      });
    }
    if (message.event === "access_token") {
      const channel = this.channels.get(message.topic);
      const token = message.payload.access_token;
      if (!channel || typeof token !== "string" || !token) {
        if (channel) {
          this.removeChannel(message.topic);
          this.forward(encodePhoenixMessage({ ...message, event: "phx_leave", payload: {} }, this.version), message.topic);
        }
        this.reply(message, "error", "Invalid access token");
        return;
      }
      const refreshVersion = ++channel.refreshVersion;
      channel.refreshing = true;
      let allowed: boolean;
      try {
        const projectRef = this.projectRef;
        allowed = await this.withDeadline(
          (async () => {
            if (!await channel.ready || !this.isCurrent(channel) || channel.refreshVersion !== refreshVersion) return false;
            return channel.nativeId === undefined || this.dependencies.backend.updateSubscriptionToken(projectRef, channel.nativeId, token);
          })(),
          REALTIME_DEADLINES.refresh, channel.controller.signal,
        );
      } catch {
        if (channel.refreshVersion === refreshVersion) this.failChannel(channel, "Access token verification timed out");
        return;
      }
      if (!this.isCurrent(channel) || channel.refreshVersion !== refreshVersion) return;
      if (!allowed) {
        this.removeChannel(message.topic);
        this.send({ ...message, event: "phx_error", payload: { reason: "Access token rejected" } });
        this.forward(encodePhoenixMessage({ ...message, event: "phx_leave", payload: {} }, this.version), message.topic);
        return;
      }
      channel.token = token;
      channel.refreshing = false;
    }
    this.forward(encoded, message.topic);
  }

  private async startNative(channel: Channel): Promise<boolean> {
    const projectRef = this.projectRef;
    if (!projectRef) return false;
    try {
      const id = await this.dependencies.backend.subscribeTenant(projectRef, channel.changes, channel.token, { signal: channel.controller.signal });
      if (!id) return false;
      if (!this.isCurrent(channel)) { this.dependencies.backend.unsubscribeSubscription(projectRef, id); return false; }
      channel.nativeId = id;
      channel.handler = (event) => {
        if (event.data.type !== "DELETE" && this.isCurrent(channel) && channel.joined && !channel.refreshing) {
          this.send({ ...channel.join, ref: null, event: "postgres_changes", payload: { ...event } });
        }
      };
      this.dependencies.backend.events.on(`change:${id}`, channel.handler);
      return true;
    } catch {
      return false;
    }
  }

  private async receiveUpstream(raw: unknown): Promise<void> {
    if (this.closed) return;
    const binary = realtimeBinary(raw);
    if (binary) {
      if (!isPhoenixBroadcastFrame(binary, "server")) this.close(1011, "Invalid upstream binary broadcast");
      else this.sendFrame(binary);
      return;
    }
    const message = parsePhoenixMessage(raw);
    if (!message) { this.close(1011, "Invalid upstream message"); return; }
    const channel = this.channels.get(message.topic);
    if (message.event === "phx_reply" && isRecord(message.payload.response)
      && message.payload.response.postgres_changes !== undefined
      && (!channel || message.ref !== channel.join.ref || message.join_ref !== channel.join.join_ref)) return;
    if (message.event === "postgres_changes") {
      if (!channel?.joined || channel.refreshing) return;
      if (message.join_ref !== null && message.join_ref !== channel.join.join_ref) return;
      const change = parseRealtimeChange(message.payload.data);
      const rawIds: unknown = message.payload.ids;
      const rawErrors: unknown = isRecord(message.payload.data) ? message.payload.data.errors : undefined;
      if (!change || !Array.isArray(rawIds) || !rawIds.length || (rawErrors != null && !Array.isArray(rawErrors))) {
        this.close(1011, "Invalid upstream change");
        return;
      }
      const ids: Array<string | number> = [];
      for (const id of rawIds) {
        if ((typeof id !== "string" && typeof id !== "number") || !channel.serverIds.includes(id)) {
          this.close(1011, "Invalid upstream subscription ID");
          return;
        }
        ids.push(id);
      }
      const errors: string[] = [];
      for (const error of rawErrors ?? []) {
        if (typeof error !== "string") { this.close(1011, "Invalid upstream change errors"); return; }
        errors.push(error);
      }
      // DELETE remains owned by the authenticated upstream's historical policy
      // implementation. The native current-row reader cannot establish that policy.
      if (channel.native && change.type !== "DELETE") return;
      for (const projected of projectRealtimeChangeEvents({ data: { ...change, errors }, ids }, channel.bindings)) {
        this.send({ ...message, payload: { ...projected } });
      }
      return;
    }
    if (message.event === "phx_reply" && channel
      && message.ref === channel.join.ref && message.join_ref === channel.join.join_ref) {
      if (message.payload.status !== "ok") this.removeChannel(message.topic);
      else if (channel.changes.length) {
        if (!await channel.ready || !this.isCurrent(channel)) {
          if (this.isCurrent(channel)) {
            this.removeChannel(message.topic);
            this.reply(channel.join, "error", "Native subscription rejected");
            this.forward(encodePhoenixMessage({ ...channel.join, event: "phx_leave", payload: {} }, this.version), message.topic);
          }
          return;
        }
        const response = message.payload.response;
        const bindings = isRecord(response) ? bindRealtimeSubscriptionIds(channel.changes, response.postgres_changes) : null;
        if (!this.projectRef || !bindings || !isRecord(response)
          || (channel.native && (!channel.nativeId
            || !this.dependencies.backend.registerSubscriptionIds(
              this.projectRef,
              channel.nativeId,
              bindings.map(({ id }) => ({ id: id ?? "" })),
            )))) {
          this.removeChannel(message.topic);
          this.reply(channel.join, "error", "Invalid subscription acknowledgement");
          this.forward(encodePhoenixMessage({ ...channel.join, event: "phx_leave", payload: {} }, this.version), message.topic);
          return;
        }
        channel.bindings = bindings;
        channel.serverIds = bindings.flatMap((mapping) => mapping.id === undefined ? [] : [mapping.id]);
        channel.joined = true;
        const config = channel.join.payload.config;
        const clientChanges = isRecord(config) && Array.isArray(config.postgres_changes) ? config.postgres_changes : [];
        // SDK binding checks distinguish an omitted field from an empty string.
        const acknowledgements = bindings.map(({ table: _table, filter: _filter, ...binding }, index) => {
          const original: unknown = clientChanges[index];
          return {
            ...binding,
            ...(isRecord(original) && typeof original.table === "string" ? { table: original.table } : {}),
            ...(isRecord(original) && typeof original.filter === "string" ? { filter: original.filter } : {}),
          };
        });
        message.payload = { ...message.payload, response: { ...response, postgres_changes: acknowledgements } };
      } else channel.joined = true;
      if (channel.joined) { channel.cancelJoinTimeout?.(); delete channel.cancelJoinTimeout; }
    }
    if ((message.event === "phx_error" || message.event === "phx_close") && channel) {
      if (message.join_ref !== null && message.join_ref !== channel.join.join_ref) return;
      this.removeChannel(message.topic);
    }
    this.send(message);
  }

  private isCurrent(channel: Channel): boolean {
    return !this.closed && this.channels.get(channel.join.topic) === channel;
  }
  private failChannel(channel: Channel, reason: string): void {
    if (!this.isCurrent(channel)) return;
    this.removeChannel(channel.join.topic);
    if (channel.joined) this.send({ ...channel.join, ref: null, event: "phx_error", payload: { reason } });
    else this.reply(channel.join, "error", reason);
    this.buffered = this.buffered.filter((frame) => frame.topic !== channel.join.topic);
    this.bufferedBytes = this.buffered.reduce((sum, frame) => sum + this.frameBytes(frame.data), 0);
    if (this.upstream?.readyState === WebSocket.OPEN) {
      this.forward(encodePhoenixMessage({ ...channel.join, event: "phx_leave", payload: {} }, this.version), channel.join.topic);
    }
  }
  private removeChannel(topic: string): void {
    const channel = this.channels.get(topic);
    if (!channel) return;
    this.channels.delete(topic);
    channel.cancelJoinTimeout?.();
    channel.controller.abort();
    if (channel.nativeId && this.projectRef) {
      if (channel.handler) this.dependencies.backend.events.off(`change:${channel.nativeId}`, channel.handler);
      this.dependencies.backend.unsubscribeSubscription(this.projectRef, channel.nativeId);
    }
  }
  private schedule(callback: () => void, milliseconds: number): () => void {
    if (this.dependencies.schedule) return this.dependencies.schedule(callback, milliseconds);
    const timer = setTimeout(callback, milliseconds);
    timer.unref();
    return () => clearTimeout(timer);
  }
  private withDeadline<T>(promise: Promise<T>, milliseconds: number, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let cancelTimer: (() => void) | undefined;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        cancelTimer?.();
        this.operations.delete(cancel);
        signal?.removeEventListener("abort", cancel);
        action();
      };
      const cancel = () => finish(() => reject(new Error("Realtime session closed")));
      this.operations.add(cancel);
      signal?.addEventListener("abort", cancel, { once: true });
      promise.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
      if (this.closed || signal?.aborted) cancel();
      else cancelTimer = this.schedule(() => finish(() => reject(new Error("Realtime operation timed out"))), milliseconds);
    });
  }
  private frameBytes(data: Frame): number { return typeof data === "string" ? Buffer.byteLength(data) : data.byteLength; }
  private forward(data: Frame, topic?: string): void {
    if (this.closed) return;
    const size = this.frameBytes(data);
    if (size > MAX_REALTIME_FRAME_BYTES) { this.close(1009, "Realtime frame too large"); return; }
    try {
      if (this.upstream?.readyState === WebSocket.OPEN) this.upstream.send(data);
      else if (this.upstream?.readyState === WebSocket.CONNECTING) {
        if (this.buffered.length >= MAX_BUFFERED_FRAMES || this.bufferedBytes + size > MAX_REALTIME_FRAME_BYTES) {
          this.close(1009, "Realtime buffer limit exceeded");
          return;
        }
        this.buffered.push({ data, ...(topic === undefined ? {} : { topic }) });
        this.bufferedBytes += size;
      }
    } catch { this.close(1011, "Upstream send failed"); }
  }
  private flush(): void {
    const frames = this.buffered;
    this.buffered = [];
    this.bufferedBytes = 0;
    for (const frame of frames) this.forward(frame.data, frame.topic);
  }
  private sendFrame(data: Frame): void {
    if (this.closed) return;
    if (this.frameBytes(data) > MAX_REALTIME_FRAME_BYTES) { this.close(1009, "Realtime frame too large"); return; }
    try { this.client.send(data); } catch { this.close(1011, "Client send failed"); }
  }
  private send(message: PhoenixMessage): void { this.sendFrame(encodePhoenixMessage(message, this.version)); }
  private reply(message: PhoenixMessage, status: "ok" | "error", reason?: string): void {
    this.send({ ...message, event: "phx_reply", payload: { status, response: reason ? { reason } : {} } });
  }
  close(code = 1000, reason = "Realtime connection closed"): void {
    if (this.closed) return;
    this.closed = true;
    for (const cancel of this.operations) cancel();
    this.cancelConnectionTimeout?.();
    this.cancelConnectionTimeout = undefined;
    for (const topic of this.channels.keys()) this.removeChannel(topic);
    this.buffered = [];
    this.bufferedBytes = 0;
    this.earlyMessages = [];
    this.earlyBytes = 0;
    if (this.projectRef) {
      const count = connectionCounts.get(this.projectRef) ?? 0;
      if (count > 1) connectionCounts.set(this.projectRef, count - 1);
      else connectionCounts.delete(this.projectRef);
    }
    try { this.upstream?.close(); } catch { /* already closed */ }
    try { this.client.close(code, reason); } catch { /* already closed */ }
    if (code === 1011) logger.warn("[Realtime Proxy] Connection closed after transport failure");
  }
}
