import { commandIdentifier } from "./receipts.js";

export interface CommandPreviewBlocker {
  code: string;
  message: string;
  correction?: string;
}

export interface CommandPreview {
  command: string;
  allowed: boolean;
  blockers: CommandPreviewBlocker[];
}

function decodeCommandPreviewBlocker(value: unknown): CommandPreviewBlocker {
  if (!value || typeof value !== "object" || !("code" in value) || !("message" in value)) {
    throw new TypeError("Invalid command preview");
  }
  if (typeof value.code !== "string" || value.code.length === 0
    || typeof value.message !== "string" || value.message.length === 0) {
    throw new TypeError("Invalid command preview");
  }
  if (!("correction" in value) || value.correction === undefined) {
    return { code: value.code, message: value.message };
  }
  if (typeof value.correction !== "string" || value.correction.length === 0) {
    throw new TypeError("Invalid command preview");
  }
  return { code: value.code, message: value.message, correction: value.correction };
}

export function decodeCommandPreview(value: unknown): CommandPreview {
  if (!value || typeof value !== "object" || !("command" in value)
    || !("allowed" in value) || !("blockers" in value)) {
    throw new TypeError("Invalid command preview");
  }
  if (typeof value.allowed !== "boolean" || !Array.isArray(value.blockers)) {
    throw new TypeError("Invalid command preview");
  }
  const blockers = value.blockers.map(decodeCommandPreviewBlocker);
  if (value.allowed ? blockers.length !== 0 : blockers.length === 0) {
    throw new TypeError("Invalid command preview");
  }
  return { command: commandIdentifier(value.command), allowed: value.allowed, blockers };
}

export function commandDisabledReason(preview: CommandPreview): string {
  if (preview.allowed) return "";
  return preview.blockers.map((blocker) => (
    blocker.correction ? `${blocker.message}；${blocker.correction}` : blocker.message
  )).join("；");
}

export function commandButtonState(preview: CommandPreview): {
  disabled: boolean;
  disabledReason: string;
} {
  const disabledReason = commandDisabledReason(preview);
  return { disabled: !preview.allowed, disabledReason };
}
