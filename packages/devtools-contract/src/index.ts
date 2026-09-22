export type DevtoolsSource = 'frontend' | 'supacloud' | 'compiler';
export type DevtoolsSeverity = 'info' | 'warning' | 'error';

export type DevtoolsTraceContext = {
  requestId?: string;
  traceId?: string;
  correlationId?: string;
};

export type DevtoolsLocation = {
  file?: string;
  line?: number;
  column?: number;
};

export type DevtoolsDiagnostic = DevtoolsTraceContext & {
  code: string;
  source: DevtoolsSource;
  severity: DevtoolsSeverity;
  message: string;
  location?: DevtoolsLocation;
  fix?: {
    kind: string;
    safe: boolean;
    input?: Record<string, unknown>;
  };
};

export type DevtoolsEvent =
  | (DevtoolsTraceContext & {
      type: 'request.started' | 'request.finished' | 'request.failed';
      durationMs?: number;
    })
  | (DevtoolsTraceContext & {
      type: 'query.started' | 'query.finished' | 'query.failed';
      provider: string;
      resource?: string;
      operation: string;
    })
  | (DevtoolsTraceContext & {
      type: 'task.updated';
      taskId: string;
      status: string;
    })
  | {
      type: 'diagnostic.emitted';
      diagnostic: DevtoolsDiagnostic;
    };

export type DevtoolsSnapshot = DevtoolsTraceContext & {
  version: 1;
  source: DevtoolsSource;
  diagnostics: DevtoolsDiagnostic[];
  events: DevtoolsEvent[];
};

const SECRET_KEY = /token|secret|password|credential|authorization|cookie|signed.?url|service.?role/i;

export function redactDevtoolsRecord(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactDevtoolsRecord);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      SECRET_KEY.test(key) ? '[redacted]' : redactDevtoolsRecord(entry),
    ]));
  }
  return value;
}

export function createDevtoolsSnapshot(
  input: Omit<DevtoolsSnapshot, 'version'>,
): DevtoolsSnapshot {
  return redactDevtoolsRecord({ version: 1, ...input }) as DevtoolsSnapshot;
}
