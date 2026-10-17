export type FunctionBytecodeMode = "off" | "auto" | "required";

export function functionBytecodeMode(value: unknown): FunctionBytecodeMode {
  if (value === undefined) return "off";
  if (value === "off" || value === "auto" || value === "required") return value;
  throw new Error("Function config contains an unsupported bytecode mode");
}

export type FunctionBytecodeArtifact = {
  sourceSha256: string;
  path: string;
  sha256: string;
  bytecodeSha256: string;
};

export function isFunctionBytecodeArtifact(value: unknown): value is FunctionBytecodeArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const artifact = value as Record<string, unknown>;
  const digest = (candidate: unknown) => typeof candidate === "string" && /^[a-f0-9]{64}$/.test(candidate);
  return typeof artifact.path === "string"
    && digest(artifact.sourceSha256) && digest(artifact.sha256) && digest(artifact.bytecodeSha256);
}
