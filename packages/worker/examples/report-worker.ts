import { createPgflowQueueWorker, type TaskContext } from "../src/index.js";

interface ReportInput {
  reportId: string;
  revision: string;
  sourceFileId: string;
}
interface ReportDomain {
  /** Load the authoritative request, entity access, source ownership and current revision. */
  authorize(input: ReportInput, context: TaskContext): Promise<boolean>;
  /** Persist a deduplicated business command/outbox receipt before external side effects. */
  generate(input: ReportInput, context: TaskContext): Promise<void>;
}

export function reportWorker(
  projectRef: string,
  connectionString: string,
  domain: ReportDomain,
) {
  return createPgflowQueueWorker(
    {
      projectRef,
      connectionString,
      queueName: "scw_reports",
      taskKey: "report.generate",
      concurrency: 4,
      visibilityTimeoutSeconds: 300,
      retryLimit: 5,
    },
    {
      decode(value): ReportInput {
        if (
          value === null ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          !("reportId" in value) ||
          typeof value.reportId !== "string" ||
          !value.reportId ||
          !("revision" in value) ||
          typeof value.revision !== "string" ||
          !value.revision ||
          !("sourceFileId" in value) ||
          typeof value.sourceFileId !== "string" ||
          !value.sourceFileId ||
          Object.keys(value).some(
            (key) => !["reportId", "revision", "sourceFileId"].includes(key),
          )
        ) {
          throw new Error("REPORT_INPUT_INVALID");
        }
        return {
          reportId: value.reportId,
          revision: value.revision,
          sourceFileId: value.sourceFileId,
        };
      },
      authorize: (input, context) => domain.authorize(input, context),
      execute: (input, context) => domain.generate(input, context),
    },
  );
}
