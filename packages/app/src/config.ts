import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export interface ConfigIssue {
  readonly path: string;
  readonly message: string;
}

export class ConfigValidationError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(name: string, issues: readonly ConfigIssue[]) {
    super(`Invalid ${name}: ${issues.map((issue) => `${issue.path} ${issue.message}`).join(", ")}`);
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

export function decodeConfig<T extends TSchema>(
  schema: T,
  value: unknown,
  name = "configuration",
): Static<T> {
  if (!Value.Check(schema, value)) {
    throw new ConfigValidationError(name, [...Value.Errors(schema, value)].map((error) => ({
      path: error.path || "/",
      message: error.message,
    })));
  }
  return value as Static<T>;
}
