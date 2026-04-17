export type FunctionRuntimeLogRecord = {
  id: string;
  timestamp: string;
  event_type: string;
  severity: string;
  message: string;
  metadata: Record<string, unknown>;
};

const ERROR_SEVERITIES = new Set(["error", "fatal", "critical"]);
const WARNING_SEVERITIES = new Set(["warn", "warning"]);

export type FunctionRuntimeSeverityFilter =
  | "all"
  | "error"
  | "warning"
  | "info";

export function getRecentFunctionRuntimeLogs(
  logs: FunctionRuntimeLogRecord[],
  maxEntries = 8,
): FunctionRuntimeLogRecord[] {
  return logs.slice(0, maxEntries);
}

export function filterFunctionRuntimeLogs(
  logs: FunctionRuntimeLogRecord[],
  options: {
    severity?: FunctionRuntimeSeverityFilter;
    search?: string;
  } = {},
): FunctionRuntimeLogRecord[] {
  const severity = options.severity ?? "all";
  const search = options.search?.trim().toLowerCase() ?? "";

  return logs.filter((log) => {
    const normalizedSeverity = log.severity.toLowerCase();
    const severityMatch =
      severity === "all" ||
      (severity === "error" && ERROR_SEVERITIES.has(normalizedSeverity)) ||
      (severity === "warning" && WARNING_SEVERITIES.has(normalizedSeverity)) ||
      (severity === "info" &&
        !ERROR_SEVERITIES.has(normalizedSeverity) &&
        !WARNING_SEVERITIES.has(normalizedSeverity));

    const searchMatch =
      !search ||
      log.message.toLowerCase().includes(search) ||
      log.event_type.toLowerCase().includes(search) ||
      normalizedSeverity.includes(search);

    return severityMatch && searchMatch;
  });
}

export function getFunctionRuntimeErrorLogs(
  logs: FunctionRuntimeLogRecord[],
  maxEntries = 3,
): FunctionRuntimeLogRecord[] {
  return logs
    .filter((log) => ERROR_SEVERITIES.has(log.severity.toLowerCase()))
    .slice(0, maxEntries);
}

export function hasFunctionRuntimeWarnings(
  logs: FunctionRuntimeLogRecord[],
): boolean {
  return logs.some((log) =>
    WARNING_SEVERITIES.has(log.severity.toLowerCase()),
  );
}

export function getFunctionRuntimeLogClass(log: FunctionRuntimeLogRecord) {
  const severity = log.severity.toLowerCase();
  if (ERROR_SEVERITIES.has(severity)) {
    return "border-red-500/20 bg-red-500/5 text-red-700";
  }

  if (WARNING_SEVERITIES.has(severity)) {
    return "border-amber-500/20 bg-amber-500/5 text-amber-700";
  }

  return "border-blue-500/20 bg-blue-500/5 text-blue-700";
}

export function getFunctionRuntimeSeveritySummary(
  logs: FunctionRuntimeLogRecord[],
) {
  return logs.reduce(
    (summary, log) => {
      const severity = log.severity.toLowerCase();
      if (ERROR_SEVERITIES.has(severity)) {
        summary.errors += 1;
      } else if (WARNING_SEVERITIES.has(severity)) {
        summary.warnings += 1;
      } else {
        summary.info += 1;
      }

      return summary;
    },
    { errors: 0, warnings: 0, info: 0 },
  );
}
