import { quoteSystemdEnvValue, renderSystemdEnvLine } from "./systemd-env";

export const AUTH_EMAIL_TEMPLATE_DEFINITIONS = [
  {
    id: "confirmation",
    legacyKey: "confirmation_mail",
    subjectKey: "mailer_subjects_confirmation",
    contentKey: "mailer_templates_confirmation_content",
    envSubject: "GOTRUE_MAILER_SUBJECTS_CONFIRMATION",
    envContent: "GOTRUE_MAILER_TEMPLATES_CONFIRMATION_CONTENT",
    defaultSubject: "Confirm your signup",
  },
  {
    id: "invite",
    legacyKey: "invitation_mail",
    subjectKey: "mailer_subjects_invite",
    contentKey: "mailer_templates_invite_content",
    envSubject: "GOTRUE_MAILER_SUBJECTS_INVITE",
    envContent: "GOTRUE_MAILER_TEMPLATES_INVITE_CONTENT",
    defaultSubject: "You have been invited",
  },
  {
    id: "magic_link",
    legacyKey: "magic_link",
    subjectKey: "mailer_subjects_magic_link",
    contentKey: "mailer_templates_magic_link_content",
    envSubject: "GOTRUE_MAILER_SUBJECTS_MAGIC_LINK",
    envContent: "GOTRUE_MAILER_TEMPLATES_MAGIC_LINK_CONTENT",
    defaultSubject: "Your magic link",
  },
  {
    id: "recovery",
    legacyKey: "recovery_mail",
    subjectKey: "mailer_subjects_recovery",
    contentKey: "mailer_templates_recovery_content",
    envSubject: "GOTRUE_MAILER_SUBJECTS_RECOVERY",
    envContent: "GOTRUE_MAILER_TEMPLATES_RECOVERY_CONTENT",
    defaultSubject: "Reset your password",
  },
  {
    id: "email_change",
    legacyKey: "email_change",
    subjectKey: "mailer_subjects_email_change",
    contentKey: "mailer_templates_email_change_content",
    envSubject: "GOTRUE_MAILER_SUBJECTS_EMAIL_CHANGE",
    envContent: "GOTRUE_MAILER_TEMPLATES_EMAIL_CHANGE_CONTENT",
    defaultSubject: "Confirm email change",
  },
  {
    id: "reauthentication",
    legacyKey: "reauthentication_mail",
    subjectKey: "mailer_subjects_reauthentication",
    contentKey: "mailer_templates_reauthentication_content",
    envSubject: "GOTRUE_MAILER_SUBJECTS_REAUTHENTICATION",
    envContent: "GOTRUE_MAILER_TEMPLATES_REAUTHENTICATION_CONTENT",
    defaultSubject: "Confirm reauthentication",
  },
] as const;

export type AuthEmailTemplateId = (typeof AUTH_EMAIL_TEMPLATE_DEFINITIONS)[number]["id"];

export interface AuthEmailTemplate {
  subject: string;
  content: string;
}

export type AuthEmailTemplateMap = Record<AuthEmailTemplateId, AuthEmailTemplate>;

type AuthEmailTemplatePatch = Partial<Record<AuthEmailTemplateId, Partial<AuthEmailTemplate>>>;

function upperKey(key: string): string {
  return key.toUpperCase();
}

function readString(config: Record<string, unknown>, key: string): string | null {
  const value = config[key] ?? config[upperKey(key)];
  return typeof value === "string" ? value : null;
}

function makeDefaults(): AuthEmailTemplateMap {
  return Object.fromEntries(
    AUTH_EMAIL_TEMPLATE_DEFINITIONS.map((definition) => [
      definition.id,
      { subject: definition.defaultSubject, content: "" },
    ]),
  ) as AuthEmailTemplateMap;
}

export function getAuthEmailTemplates(authConfig: Record<string, unknown>): AuthEmailTemplateMap {
  const templates = makeDefaults();
  for (const definition of AUTH_EMAIL_TEMPLATE_DEFINITIONS) {
    templates[definition.id] = {
      subject:
        readString(authConfig, definition.subjectKey) ??
        templates[definition.id].subject,
      content:
        readString(authConfig, definition.contentKey) ??
        templates[definition.id].content,
    };
  }
  return templates;
}

export function buildLegacyAuthEmailTemplateResponse(templates: AuthEmailTemplateMap) {
  return Object.fromEntries(
    AUTH_EMAIL_TEMPLATE_DEFINITIONS.map((definition) => [
      definition.legacyKey,
      {
        subject: templates[definition.id].subject,
        content: templates[definition.id].content,
      },
    ]),
  );
}

function readTemplateFromObject(value: unknown): Partial<AuthEmailTemplate> {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.subject === "string" ? { subject: record.subject } : {}),
    ...(typeof record.content === "string" ? { content: record.content } : {}),
    ...(typeof record.body === "string" ? { content: record.body } : {}),
  };
}

export function parseAuthEmailTemplatePatch(body: unknown): AuthEmailTemplatePatch {
  if (!body || typeof body !== "object") return {};
  const record = body as Record<string, unknown>;
  const source = record.templates && typeof record.templates === "object"
    ? record.templates as Record<string, unknown>
    : record;
  const patch: AuthEmailTemplatePatch = {};

  for (const definition of AUTH_EMAIL_TEMPLATE_DEFINITIONS) {
    const direct = readTemplateFromObject(source[definition.id]);
    const legacy = readTemplateFromObject(source[definition.legacyKey]);
    const subject =
      direct.subject ??
      legacy.subject ??
      (typeof source[definition.subjectKey] === "string"
        ? source[definition.subjectKey] as string
        : undefined) ??
      (typeof source[upperKey(definition.subjectKey)] === "string"
        ? source[upperKey(definition.subjectKey)] as string
        : undefined);
    const content =
      direct.content ??
      legacy.content ??
      (typeof source[definition.contentKey] === "string"
        ? source[definition.contentKey] as string
        : undefined) ??
      (typeof source[upperKey(definition.contentKey)] === "string"
        ? source[upperKey(definition.contentKey)] as string
        : undefined);

    if (subject !== undefined || content !== undefined) {
      patch[definition.id] = {
        ...(subject !== undefined ? { subject } : {}),
        ...(content !== undefined ? { content } : {}),
      };
    }
  }

  return patch;
}

export function applyAuthEmailTemplatePatch(
  authConfig: Record<string, unknown>,
  patch: AuthEmailTemplatePatch,
): Record<string, unknown> {
  const next = { ...authConfig };
  for (const definition of AUTH_EMAIL_TEMPLATE_DEFINITIONS) {
    const update = patch[definition.id];
    if (!update) continue;
    if (update.subject !== undefined) {
      next[definition.subjectKey] = update.subject;
    }
    if (update.content !== undefined) {
      next[definition.contentKey] = update.content;
    }
  }
  return next;
}

export function clearAuthEmailTemplates(authConfig: Record<string, unknown>): Record<string, unknown> {
  const next = { ...authConfig };
  for (const definition of AUTH_EMAIL_TEMPLATE_DEFINITIONS) {
    delete next[definition.subjectKey];
    delete next[definition.contentKey];
    delete next[upperKey(definition.subjectKey)];
    delete next[upperKey(definition.contentKey)];
  }
  return next;
}

export function renderGoTrueEmailTemplateEnv(authConfig: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const definition of AUTH_EMAIL_TEMPLATE_DEFINITIONS) {
    const subject = readString(authConfig, definition.subjectKey);
    const content = readString(authConfig, definition.contentKey);
    if (subject !== null) {
      lines.push(renderSystemdEnvLine(definition.envSubject, subject));
    }
    if (content !== null) {
      lines.push(`${definition.envContent}=${quoteSystemdEnvValue(content)}`);
    }
  }
  return lines.join("\n");
}
