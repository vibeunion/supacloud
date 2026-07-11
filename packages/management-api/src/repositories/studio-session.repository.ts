import { sql } from "../db";

export interface StudioSessionRecord {
  id: string;
  username: string;
  expiresAt: Date;
}

export interface CreateStudioSessionInput {
  username: string;
  tokenHash: string;
  expiresAt: Date;
  ipHash: string;
  userAgent: string;
}

export interface RotateStudioSessionInput {
  currentTokenHash: string;
  nextTokenHash: string;
  expiresAt: Date;
  ipHash: string;
  userAgent: string;
}

export interface StudioSessionRepository {
  create(input: CreateStudioSessionInput): Promise<StudioSessionRecord>;
  findActiveByTokenHash(tokenHash: string): Promise<StudioSessionRecord | null>;
  rotate(input: RotateStudioSessionInput): Promise<StudioSessionRecord | null>;
  revoke(tokenHash: string): Promise<boolean>;
}

type StudioSessionRow = {
  id: string;
  username: string;
  expires_at: Date | string;
};

function mapStudioSession(row: StudioSessionRow): StudioSessionRecord {
  return {
    id: row.id,
    username: row.username,
    expiresAt: row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at),
  };
}

async function create(input: CreateStudioSessionInput): Promise<StudioSessionRecord> {
  // Sessions are short lived; pruning on login keeps revoked/expired rows from
  // accumulating without requiring a separate scheduler.
  await sql`
    DELETE FROM studio_sessions
    WHERE expires_at <= NOW()
  `;
  const [row] = await sql`
    INSERT INTO studio_sessions (username, token_hash, expires_at, ip_hash, user_agent)
    VALUES (${input.username}, ${input.tokenHash}, ${input.expiresAt}, ${input.ipHash}, ${input.userAgent})
    RETURNING id, username, expires_at
  ` as unknown as StudioSessionRow[];
  if (!row) throw new Error("Failed to create Studio session");
  return mapStudioSession(row);
}

async function findActiveByTokenHash(tokenHash: string): Promise<StudioSessionRecord | null> {
  const [row] = await sql`
    SELECT id, username, expires_at
    FROM studio_sessions
    WHERE token_hash = ${tokenHash}
      AND revoked_at IS NULL
      AND expires_at > NOW()
    LIMIT 1
  ` as unknown as StudioSessionRow[];
  return row ? mapStudioSession(row) : null;
}

async function rotate(input: RotateStudioSessionInput): Promise<StudioSessionRecord | null> {
  const [row] = await sql`
    UPDATE studio_sessions
    SET token_hash = ${input.nextTokenHash},
        expires_at = ${input.expiresAt},
        ip_hash = ${input.ipHash},
        user_agent = ${input.userAgent},
        last_seen_at = NOW()
    WHERE token_hash = ${input.currentTokenHash}
      AND revoked_at IS NULL
      AND expires_at > NOW()
    RETURNING id, username, expires_at
  ` as unknown as StudioSessionRow[];
  return row ? mapStudioSession(row) : null;
}

async function revoke(tokenHash: string): Promise<boolean> {
  const rows = await sql`
    UPDATE studio_sessions
    SET revoked_at = NOW(), last_seen_at = NOW()
    WHERE token_hash = ${tokenHash} AND revoked_at IS NULL
    RETURNING id
  `;
  return rows.length > 0;
}

export const studioSessionRepository: StudioSessionRepository = {
  create,
  findActiveByTokenHash,
  rotate,
  revoke,
};
