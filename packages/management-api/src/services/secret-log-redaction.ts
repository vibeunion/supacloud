const JSON_SECRET_PATTERN = /("(?:db_password|password|jwt_secret|secret)"\s*:\s*")([^"\\]*)(")/gi;
const URI_PASSWORD_PATTERN = /\b(postgres(?:ql)?:\/\/[^:\s/@]*):([^@\s/]+)@/gi;

/**
 * Strip credential material from text that may be logged or returned.
 * Short values are left intact so a default like "postgres" is not erased
 * from unrelated words; JSON fields and URI userinfo are always redacted.
 */
export function redactLoggedSecrets(text: string, secrets: readonly string[] = []): string {
  let redacted = text
    .replace(JSON_SECRET_PATTERN, "$1[REDACTED]$3")
    .replace(URI_PASSWORD_PATTERN, "$1:[REDACTED]@");
  for (const secret of secrets) {
    if (secret.length < 12) continue;
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}
