/**
 * Realtime Adapter for SupaCloud.
 *
 * Provides a pluggable, 100% Supabase-compatible RealtimeChannel facade.
 * Allows switching the underlying transport (WebSocket, Centrifugo, SSE, in-memory)
 * while preserving the standard supabase-js channel syntax (.on('postgres_changes' | 'broadcast' | 'presence')).
 */

export type RealtimeChannelStatus =
  | "CLOSED"
  | "ERRORED"
  | "SUBSCRIBED"
  | "TIMED_OUT";

export type PostgresChangeEvent = "INSERT" | "UPDATE" | "DELETE" | "*";

export interface PostgresChangesFilter {
  event: PostgresChangeEvent;
  schema: string;
  table?: string;
  filter?: string;
}

export interface RealtimePostgresChangesPayload<
  T extends Record<string, unknown> = Record<string, unknown>,
> {
  schema: string;
  table: string;
  commit_timestamp: string;
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: T;
  old: Partial<T>;
  errors: string[];
}

export interface RealtimeBroadcastPayload<T = unknown> {
  type: "broadcast";
  event: string;
  payload: T;
}

export type RealtimePresenceState<T = Record<string, unknown>> = Record<
  string,
  Array<{ presence_ref: string } & T>
>;

export interface RealtimePresenceJoinPayload<T = Record<string, unknown>> {
  key: string;
  currentPresences: Array<{ presence_ref: string } & T>;
  newPresences: Array<{ presence_ref: string } & T>;
}

export interface RealtimePresenceLeavePayload<T = Record<string, unknown>> {
  key: string;
  currentPresences: Array<{ presence_ref: string } & T>;
  leftPresences: Array<{ presence_ref: string } & T>;
}

export type RealtimeCallbackResponse = "ok" | "timed out" | "error";

export interface RealtimeChannelConfig {
  broadcast?: {
    self?: boolean;
    ack?: boolean;
  };
  presence?: {
    key?: string;
  };
}

export interface RealtimeTransportMessage {
  topic: string;
  event: string;
  payload: Record<string, unknown>;
  ref?: string | null;
}

export interface RealtimeTransport {
  connect?(): Promise<void> | void;
  disconnect?(): Promise<void> | void;
  send(message: RealtimeTransportMessage): Promise<void> | void;
  subscribe(
    topic: string,
    onMessage: (message: RealtimeTransportMessage) => void,
  ): () => void;
  isConnected?(): boolean;
}

/**
 * Evaluates standard Supabase realtime change filter expressions.
 * E.g. "id=eq.123", "status=neq.deleted", "score=gte.10", "role=in.(admin,editor)"
 */
export function matchesPostgresFilter(
  filterStr: string | undefined,
  record: Record<string, unknown>,
): boolean {
  if (!filterStr || !filterStr.trim()) return true;
  const eqIdx = filterStr.indexOf("=");
  if (eqIdx === -1) return true;

  const col = filterStr.substring(0, eqIdx).trim();
  const rest = filterStr.substring(eqIdx + 1).trim();
  const dotIdx = rest.indexOf(".");
  if (dotIdx === -1) return true;

  const op = rest.substring(0, dotIdx).trim().toLowerCase();
  const rawVal = rest.substring(dotIdx + 1).trim();

  const val = record[col];
  const strVal = val === null || val === undefined ? "" : String(val);

  switch (op) {
    case "eq":
      return strVal === rawVal;
    case "neq":
      return strVal !== rawVal;
    case "gt": {
      const nVal = Number(val);
      const nTarget = Number(rawVal);
      return !isNaN(nVal) && !isNaN(nTarget) ? nVal > nTarget : strVal > rawVal;
    }
    case "gte": {
      const nVal = Number(val);
      const nTarget = Number(rawVal);
      return !isNaN(nVal) && !isNaN(nTarget) ? nVal >= nTarget : strVal >= rawVal;
    }
    case "lt": {
      const nVal = Number(val);
      const nTarget = Number(rawVal);
      return !isNaN(nVal) && !isNaN(nTarget) ? nVal < nTarget : strVal < rawVal;
    }
    case "lte": {
      const nVal = Number(val);
      const nTarget = Number(rawVal);
      return !isNaN(nVal) && !isNaN(nTarget) ? nVal <= nTarget : strVal <= rawVal;
    }
    case "in": {
      const inner = rawVal.replace(/^\(|\)$/g, "");
      const items = inner.split(",").map((s) => s.trim());
      return items.includes(strVal);
    }
    default:
      return true;
  }
}

/**
 * In-memory transport for testing, embedded runtimes, and local event dispatch.
 */
export class MemoryRealtimeTransport implements RealtimeTransport {
  private subscribers = new Map<string, Set<(msg: RealtimeTransportMessage) => void>>();
  private connected = true;

  connect(): void {
    this.connected = true;
  }

  disconnect(): void {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  send(message: RealtimeTransportMessage): void {
    if (!this.connected) return;
    const targets = this.subscribers.get(message.topic);
    if (!targets) return;
    for (const callback of targets) {
      try {
        callback(message);
      } catch {
        // preserve other subscribers
      }
    }
  }

  subscribe(
    topic: string,
    onMessage: (message: RealtimeTransportMessage) => void,
  ): () => void {
    let set = this.subscribers.get(topic);
    if (!set) {
      set = new Set();
      this.subscribers.set(topic, set);
    }
    set.add(onMessage);

    return () => {
      const current = this.subscribers.get(topic);
      if (current) {
        current.delete(onMessage);
        if (current.size === 0) {
          this.subscribers.delete(topic);
        }
      }
    };
  }

  clear(): void {
    this.subscribers.clear();
  }
}

/**
 * A standard-compliant RealtimeChannel adapter.
 * Mirroring Supabase RealtimeChannel semantics.
 */
export class SupaCloudRealtimeChannel {
  readonly topic: string;
  private readonly config: RealtimeChannelConfig;
  private readonly transport: RealtimeTransport;
  private channelStatus: RealtimeChannelStatus = "CLOSED";

  private statusCallbacks: Array<(status: RealtimeChannelStatus, err?: Error) => void> = [];
  private postgresCallbacks: Array<{
    filter: PostgresChangesFilter;
    callback: (payload: RealtimePostgresChangesPayload) => void;
  }> = [];
  private broadcastCallbacks: Array<{
    event: string;
    callback: (payload: RealtimeBroadcastPayload) => void;
  }> = [];
  private presenceCallbacks: Array<{
    event: "sync" | "join" | "leave";
    callback: (payload: unknown) => void;
  }> = [];

  private presences: RealtimePresenceState = {};
  private presenceKey: string;
  private localPresenceRef: string;
  private transportUnsubscribe: (() => void) | null = null;
  private subscriptionTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    topic: string,
    transport: RealtimeTransport,
    config: RealtimeChannelConfig = {},
  ) {
    this.topic = topic;
    this.transport = transport;
    this.config = config;
    this.presenceKey =
      config.presence?.key ??
      (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `sub_${Math.random().toString(36).substring(2, 10)}`);
    this.localPresenceRef =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `ref_${Math.random().toString(36).substring(2, 10)}`;
  }

  get state(): RealtimeChannelStatus {
    return this.channelStatus;
  }

  /**
   * Register an event listener for postgres_changes, broadcast, or presence.
   */
  on(
    type: "postgres_changes",
    filter: PostgresChangesFilter,
    callback: (payload: RealtimePostgresChangesPayload) => void,
  ): this;
  on(
    type: "broadcast",
    filter: { event: string },
    callback: (payload: RealtimeBroadcastPayload) => void,
  ): this;
  on(
    type: "presence",
    filter: { event: "sync" | "join" | "leave" },
    callback: (payload: unknown) => void,
  ): this;
  on(
    type: string,
    filter: { event?: string },
    callback: (payload: unknown) => void,
  ): this {
    if (type === "postgres_changes") {
      this.postgresCallbacks.push({
        filter: filter as unknown as PostgresChangesFilter,
        callback: callback as (payload: RealtimePostgresChangesPayload) => void,
      });
    } else if (type === "broadcast") {
      const evt = String(filter.event ?? "*");
      this.broadcastCallbacks.push({
        event: evt,
        callback: callback as (payload: RealtimeBroadcastPayload) => void,
      });
    } else if (type === "presence") {
      const evt = (filter.event as "sync" | "join" | "leave") ?? "sync";
      this.presenceCallbacks.push({
        event: evt,
        callback,
      });
    }
    return this;
  }

  /**
   * Subscribe to the channel.
   */
  subscribe(
    callback?: (status: RealtimeChannelStatus, err?: Error) => void,
    timeoutMs: number = 10000,
  ): this {
    if (callback) {
      this.statusCallbacks.push(callback);
    }

    if (this.channelStatus === "SUBSCRIBED") {
      if (callback) callback("SUBSCRIBED");
      return this;
    }

    if (this.transport.connect) {
      void Promise.resolve(this.transport.connect()).catch((err) => {
        this.emitStatus("ERRORED", err instanceof Error ? err : new Error(String(err)));
      });
    }

    // Attach timeout guard
    if (timeoutMs > 0) {
      this.subscriptionTimer = setTimeout(() => {
        if (this.channelStatus !== "SUBSCRIBED" && this.channelStatus !== "CLOSED") {
          this.emitStatus("TIMED_OUT", new Error(`Subscription timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
    }

    // Subscribe to messages on transport
    this.transportUnsubscribe = this.transport.subscribe(this.topic, (message) => {
      this.handleIncomingMessage(message);
    });

    // Notify connected
    if (this.subscriptionTimer) {
      clearTimeout(this.subscriptionTimer);
      this.subscriptionTimer = null;
    }
    this.emitStatus("SUBSCRIBED");

    return this;
  }

  /**
   * Unsubscribe and cleanup all handlers.
   */
  async unsubscribe(): Promise<RealtimeCallbackResponse> {
    if (this.subscriptionTimer) {
      clearTimeout(this.subscriptionTimer);
      this.subscriptionTimer = null;
    }
    if (this.transportUnsubscribe) {
      this.transportUnsubscribe();
      this.transportUnsubscribe = null;
    }

    // Untrack local presence
    await this.untrack();

    this.emitStatus("CLOSED");
    return "ok";
  }

  /**
   * Broadcast a payload to all clients subscribed to this channel.
   */
  async send(args: {
    type: "broadcast";
    event: string;
    payload: unknown;
  }): Promise<RealtimeCallbackResponse> {
    if (this.channelStatus === "CLOSED") {
      return "error";
    }

    const message: RealtimeTransportMessage = {
      topic: this.topic,
      event: "broadcast",
      payload: {
        type: "broadcast",
        event: args.event,
        payload: args.payload,
        __sender: this.localPresenceRef,
      },
    };

    try {
      await this.transport.send(message);
      return "ok";
    } catch {
      return "error";
    }
  }

  /**
   * Track state on this channel for Presence.
   */
  async track(payload: Record<string, unknown>): Promise<RealtimeCallbackResponse> {
    if (this.channelStatus === "CLOSED") return "error";

    const entry = {
      presence_ref: this.localPresenceRef,
      ...payload,
    };

    const message: RealtimeTransportMessage = {
      topic: this.topic,
      event: "presence_join",
      payload: {
        key: this.presenceKey,
        current: [entry],
      },
    };

    try {
      await this.transport.send(message);

      // Apply locally
      const prev = this.presences[this.presenceKey] ?? [];
      const updated = [
        ...prev.filter((p) => p.presence_ref !== this.localPresenceRef),
        entry,
      ];
      this.presences[this.presenceKey] = updated;

      this.dispatchPresence("join", {
        key: this.presenceKey,
        currentPresences: updated,
        newPresences: [entry],
      });
      this.dispatchPresence("sync", this.presences);

      return "ok";
    } catch {
      return "error";
    }
  }

  /**
   * Stop tracking presence on this channel.
   */
  async untrack(): Promise<RealtimeCallbackResponse> {
    const prev = this.presences[this.presenceKey];
    if (!prev || prev.length === 0) return "ok";

    const left = prev.filter((p) => p.presence_ref === this.localPresenceRef);
    if (left.length === 0) return "ok";

    const remaining = prev.filter((p) => p.presence_ref !== this.localPresenceRef);
    if (remaining.length === 0) {
      delete this.presences[this.presenceKey];
    } else {
      this.presences[this.presenceKey] = remaining;
    }

    const message: RealtimeTransportMessage = {
      topic: this.topic,
      event: "presence_leave",
      payload: {
        key: this.presenceKey,
        left,
      },
    };

    try {
      await this.transport.send(message);
    } catch {
      // ignore send error on unregister
    }

    this.dispatchPresence("leave", {
      key: this.presenceKey,
      currentPresences: remaining,
      leftPresences: left,
    });
    this.dispatchPresence("sync", this.presences);

    return "ok";
  }

  /**
   * Get the current presence state.
   */
  presenceState<T = Record<string, unknown>>(): RealtimePresenceState<T> {
    return this.presences as RealtimePresenceState<T>;
  }

  private emitStatus(status: RealtimeChannelStatus, err?: Error): void {
    this.channelStatus = status;
    for (const cb of this.statusCallbacks) {
      try {
        cb(status, err);
      } catch {
        // preserve other listeners
      }
    }
  }

  private handleIncomingMessage(message: RealtimeTransportMessage): void {
    const { event, payload } = message;

    if (event === "postgres_changes") {
      this.dispatchPostgresChange(payload as unknown as RealtimePostgresChangesPayload);
    } else if (event === "broadcast") {
      const sender = payload.__sender;
      if (sender === this.localPresenceRef && !this.config.broadcast?.self) {
        return; // skip self broadcast if self is disabled
      }
      const bPayload = (payload.payload !== undefined ? payload.payload : payload) as Record<string, unknown>;
      const bEvent = String(payload.event ?? "*");
      this.dispatchBroadcast(bEvent, bPayload);
    } else if (event === "presence_join") {
      const key = String(payload.key ?? "");
      const incoming = (payload.current as Array<{ presence_ref: string }>) ?? [];
      const prev = this.presences[key] ?? [];
      const updated = [
        ...prev.filter((p) => !incoming.some((i) => i.presence_ref === p.presence_ref)),
        ...incoming,
      ];
      this.presences[key] = updated;

      this.dispatchPresence("join", {
        key,
        currentPresences: updated,
        newPresences: incoming,
      });
      this.dispatchPresence("sync", this.presences);
    } else if (event === "presence_leave") {
      const key = String(payload.key ?? "");
      const left = (payload.left as Array<{ presence_ref: string }>) ?? [];
      const prev = this.presences[key] ?? [];
      const remaining = prev.filter((p) => !left.some((l) => l.presence_ref === p.presence_ref));

      if (remaining.length === 0) {
        delete this.presences[key];
      } else {
        this.presences[key] = remaining;
      }

      this.dispatchPresence("leave", {
        key,
        currentPresences: remaining,
        leftPresences: left,
      });
      this.dispatchPresence("sync", this.presences);
    }
  }

  private dispatchPostgresChange(payload: RealtimePostgresChangesPayload): void {
    if (!payload || !payload.schema || !payload.table || !payload.eventType) return;

    for (const { filter, callback } of this.postgresCallbacks) {
      // 1. Schema check
      if (filter.schema !== "*" && filter.schema.toLowerCase() !== payload.schema.toLowerCase()) {
        continue;
      }
      // 2. Table check
      if (
        filter.table &&
        filter.table !== "*" &&
        filter.table.toLowerCase() !== payload.table.toLowerCase()
      ) {
        continue;
      }
      // 3. Event check ('INSERT' | 'UPDATE' | 'DELETE' | '*')
      if (
        filter.event !== "*" &&
        filter.event.toUpperCase() !== payload.eventType.toUpperCase()
      ) {
        continue;
      }
      // 4. Record filter expression check
      const recordToMatch =
        payload.eventType === "DELETE" ? payload.old : payload.new;
      if (recordToMatch && !matchesPostgresFilter(filter.filter, recordToMatch)) {
        continue;
      }

      try {
        callback(payload);
      } catch {
        // preserve other listeners
      }
    }
  }

  private dispatchBroadcast(event: string, payload: unknown): void {
    for (const listener of this.broadcastCallbacks) {
      if (listener.event === "*" || listener.event === event) {
        try {
          listener.callback({
            type: "broadcast",
            event,
            payload,
          });
        } catch {
          // preserve other listeners
        }
      }
    }
  }

  private dispatchPresence(event: "sync" | "join" | "leave", payload: unknown): void {
    for (const listener of this.presenceCallbacks) {
      if (listener.event === event) {
        try {
          listener.callback(payload);
        } catch {
          // preserve other listeners
        }
      }
    }
  }
}

/**
 * Options to configure a Realtime Adapter instance.
 */
export interface RealtimeAdapterOptions {
  transport?: RealtimeTransport;
  projectRef?: string;
  defaultTimeoutMs?: number;
}

export interface SupaCloudRealtimeAdapter {
  channel(topic: string, config?: RealtimeChannelConfig): SupaCloudRealtimeChannel;
  readonly transport: RealtimeTransport;
}

/**
 * Creates a standard Realtime Adapter factory conforming to supabase-js conventions.
 */
export function createRealtimeAdapter(
  options: RealtimeAdapterOptions = {},
): SupaCloudRealtimeAdapter {
  const transport = options.transport ?? new MemoryRealtimeTransport();

  return {
    channel(topic: string, config?: RealtimeChannelConfig): SupaCloudRealtimeChannel {
      return new SupaCloudRealtimeChannel(topic, transport, config);
    },
    get transport(): RealtimeTransport {
      return transport;
    },
  };
}
