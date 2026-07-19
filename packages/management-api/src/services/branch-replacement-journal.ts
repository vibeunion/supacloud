import { sql } from "../db";

export type BranchReplacementPhase =
  | "preparing"
  | "prepared"
  | "connections_disabled"
  | "parent_renamed"
  | "replacement_committed"
  | "recovery_required";

export interface BranchReplacementJournalEntry {
  parent_ref: string;
  branch_ref: string;
  parent_db: string;
  branch_db: string;
  temp_db: string;
  backup_db: string;
  phase: BranchReplacementPhase;
  replacement_committed: boolean;
  recovery_database: string | null;
  updated_at: string;
}

interface BeginReplacementInput {
  parentRef: string;
  branchRef: string;
  parentDb: string;
  branchDb: string;
  tempDb: string;
  backupDb: string;
}

export class BranchReplacementJournalActiveError extends Error {
  readonly code = "database_replacement_active" as const;
  readonly httpStatus = 423 as const;

  constructor(readonly projectRef: string) {
    super(`Database migrations are blocked while replacement recovery is active for ${projectRef}`);
    this.name = "BranchReplacementJournalActiveError";
  }
}

let journalReady: Promise<void> | null = null;

async function ensureJournal(): Promise<void> {
  journalReady ??= (async () => {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS branch_replacement_journal (
        parent_ref TEXT PRIMARY KEY,
        branch_ref TEXT NOT NULL,
        parent_db TEXT NOT NULL,
        branch_db TEXT NOT NULL,
        temp_db TEXT NOT NULL,
        backup_db TEXT NOT NULL,
        phase TEXT NOT NULL,
        replacement_committed BOOLEAN NOT NULL DEFAULT FALSE,
        recovery_database TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await sql.unsafe("ALTER TABLE branch_replacement_journal ADD COLUMN IF NOT EXISTS recovery_database TEXT");
    await sql.unsafe("ALTER TABLE branch_replacement_journal ADD COLUMN IF NOT EXISTS replacement_committed BOOLEAN NOT NULL DEFAULT FALSE");
  })();
  try {
    await journalReady;
  } catch (error: unknown) {
    journalReady = null;
    throw error;
  }
}

export function resetBranchReplacementJournalForTests(): void {
  journalReady = null;
}

export const branchReplacementJournal = {
  async assertInactive(projectRefs: readonly string[]): Promise<void> {
    await ensureJournal();
    for (const projectRef of [...new Set(projectRefs.filter(Boolean))]) {
      const [row] = await sql<{ parent_ref: string }[]>`
        SELECT parent_ref
        FROM branch_replacement_journal
        WHERE parent_ref = ${projectRef} OR branch_ref = ${projectRef}
        LIMIT 1
      `;
      if (row) throw new BranchReplacementJournalActiveError(projectRef);
    }
  },

  async begin(input: BeginReplacementInput): Promise<void> {
    await ensureJournal();
    await sql`
      INSERT INTO branch_replacement_journal (
        parent_ref, branch_ref, parent_db, branch_db, temp_db, backup_db, phase,
        replacement_committed, recovery_database, updated_at
      ) VALUES (
        ${input.parentRef}, ${input.branchRef}, ${input.parentDb}, ${input.branchDb},
        ${input.tempDb}, ${input.backupDb}, 'preparing', FALSE, NULL, now()
      )
      ON CONFLICT (parent_ref) DO UPDATE SET
        branch_ref = EXCLUDED.branch_ref,
        parent_db = EXCLUDED.parent_db,
        branch_db = EXCLUDED.branch_db,
        temp_db = EXCLUDED.temp_db,
        backup_db = EXCLUDED.backup_db,
        phase = EXCLUDED.phase,
        replacement_committed = FALSE,
        recovery_database = NULL,
        updated_at = now()
    `;
  },

  async setPhase(
    parentRef: string,
    phase: BranchReplacementPhase,
    recoveryDatabase?: string,
    replacementCommitted?: boolean,
  ): Promise<void> {
    await ensureJournal();
    await sql`
      UPDATE branch_replacement_journal
      SET phase = ${phase},
          replacement_committed = COALESCE(${replacementCommitted ?? null}, replacement_committed),
          recovery_database = ${recoveryDatabase ?? null},
          updated_at = now()
      WHERE parent_ref = ${parentRef}
    `;
  },

  async get(parentRef: string): Promise<BranchReplacementJournalEntry | null> {
    await ensureJournal();
    const [row] = await sql<BranchReplacementJournalEntry[]>`
      SELECT parent_ref, branch_ref, parent_db, branch_db, temp_db, backup_db,
             phase, replacement_committed, recovery_database, updated_at::text AS updated_at
      FROM branch_replacement_journal
      WHERE parent_ref = ${parentRef}
      LIMIT 1
    `;
    return row ?? null;
  },

  async list(): Promise<BranchReplacementJournalEntry[]> {
    await ensureJournal();
    return sql<BranchReplacementJournalEntry[]>`
      SELECT parent_ref, branch_ref, parent_db, branch_db, temp_db, backup_db,
             phase, replacement_committed, recovery_database, updated_at::text AS updated_at
      FROM branch_replacement_journal
      ORDER BY updated_at ASC
    `;
  },

  async remove(parentRef: string): Promise<void> {
    await ensureJournal();
    await sql`DELETE FROM branch_replacement_journal WHERE parent_ref = ${parentRef}`;
  },
};
