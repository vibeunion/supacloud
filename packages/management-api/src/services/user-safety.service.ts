import { randomUUID } from "node:crypto";
import type { SQL } from "bun";
import { sql } from "../db";
import { taskRepository } from "../repositories/task.repository";
import {
  normalizedGoTrueUserId,
  projectUserLifecycleLockKey,
} from "../utils/project-user-lifecycle";

export interface ActiveTasksCheckResult {
  safe: boolean;
  activeTaskCount: number;
  activeTasks: Array<{ id: string; task_type: string; status: string }>;
}

export type UserDeletionFenceStatus = "requested" | "deleting" | "deleted" | "failed";

export interface BeginUserDeletionInput {
  projectRef: string;
  userId: string;
  requestId: string;
  shouldSoftDelete: boolean;
}

export interface UserDeletionOperationInput {
  projectRef: string;
  userId: string;
  operationId: string;
}

export type BeginUserDeletionResult =
  | ({ state: "blocked" } & ActiveTasksCheckResult)
  | { state: "in_progress"; status: "requested" | "deleting"; requestId: string; operationId: string }
  | {
      state: "reconcile";
      status: "requested" | "deleting";
      requestId: string;
      operationId: string;
      shouldSoftDelete: boolean;
    }
  | { state: "already_deleted"; shouldSoftDelete: boolean; completedAt: Date | null }
  | { state: "ready"; normalizedUserId: string; operationId: string };

export type ResumeUserDeletionResult =
  | ({ state: "blocked" } & ActiveTasksCheckResult)
  | { state: "operation_changed" }
  | { state: "ready"; normalizedUserId: string; operationId: string };

type DeletionFenceRow = {
  status: UserDeletionFenceStatus;
  should_soft_delete: boolean;
  request_id: string;
  operation_id: string;
  completed_at: Date | null;
  operation_active: boolean;
};

async function lockUserLifecycle(transaction: SQL, projectRef: string, userId: string): Promise<void> {
  const lockKey = projectUserLifecycleLockKey(projectRef, userId);
  await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
}

async function deletionFence(
  transaction: SQL,
  projectRef: string,
  userId: string,
): Promise<DeletionFenceRow | null> {
  const [fence] = await transaction`
    SELECT
      status,
      should_soft_delete,
      request_id,
      operation_id,
      completed_at,
      operation_expires_at > NOW() AS operation_active
    FROM project_user_deletion_fences
    WHERE project_ref = ${projectRef}
      AND user_id = ${userId}::uuid
    FOR UPDATE
  ` as DeletionFenceRow[];
  return fence || null;
}

async function activeTasks(
  projectRef: string,
  userId: string,
  transaction: SQL,
): Promise<ActiveTasksCheckResult> {
  const { count, tasks } = await taskRepository.countActiveTasksByInvoker(
    projectRef,
    userId,
    transaction,
  );
  return {
    safe: count === 0,
    activeTaskCount: count,
    activeTasks: tasks,
  };
}

export async function beginUserDeletion(input: BeginUserDeletionInput): Promise<BeginUserDeletionResult> {
  const userId = normalizedGoTrueUserId(input.userId);
  if (!userId) throw new Error("GoTrue user id must be a UUID");

  return sql.begin(async (transaction) => {
    await lockUserLifecycle(transaction, input.projectRef, userId);
    const existingFence = await deletionFence(transaction, input.projectRef, userId);
    if (existingFence?.status === "deleted") {
      return {
        state: "already_deleted" as const,
        shouldSoftDelete: existingFence.should_soft_delete,
        completedAt: existingFence.completed_at,
      };
    }
    if (existingFence?.status === "requested" || existingFence?.status === "deleting") {
      if (existingFence.operation_active) {
        return {
          state: "in_progress" as const,
          status: existingFence.status,
          requestId: existingFence.request_id,
          operationId: existingFence.operation_id,
        };
      }
      return {
        state: "reconcile" as const,
        status: existingFence.status,
        requestId: existingFence.request_id,
        operationId: existingFence.operation_id,
        shouldSoftDelete: existingFence.should_soft_delete,
      };
    }

    const taskSafety = await activeTasks(input.projectRef, userId, transaction);
    if (!taskSafety.safe) return { state: "blocked" as const, ...taskSafety };

    const operationId = randomUUID();
    await transaction`
      INSERT INTO project_user_deletion_fences (
        project_ref,
        user_id,
        status,
        should_soft_delete,
        request_id,
        operation_id,
        operation_expires_at,
        last_error,
        requested_at,
        deletion_started_at,
        completed_at,
        updated_at
      )
      VALUES (
        ${input.projectRef},
        ${userId}::uuid,
        'requested',
        ${input.shouldSoftDelete},
        ${input.requestId},
        ${operationId}::uuid,
        NOW() + INTERVAL '5 minutes',
        NULL,
        NOW(),
        NULL,
        NULL,
        NOW()
      )
      ON CONFLICT (project_ref, user_id)
      DO UPDATE SET
        status = 'requested',
        should_soft_delete = EXCLUDED.should_soft_delete,
        request_id = EXCLUDED.request_id,
        operation_id = EXCLUDED.operation_id,
        operation_expires_at = EXCLUDED.operation_expires_at,
        last_error = NULL,
        requested_at = NOW(),
        deletion_started_at = NULL,
        completed_at = NULL,
        updated_at = NOW()
    `;
    return { state: "ready" as const, normalizedUserId: userId, operationId };
  });
}

export async function resumeUserDeletionAfterReconcile(
  input: BeginUserDeletionInput,
  reconciledOperationId: string,
): Promise<ResumeUserDeletionResult> {
  const userId = normalizedGoTrueUserId(input.userId);
  if (!userId) throw new Error("GoTrue user id must be a UUID");

  return sql.begin(async (transaction) => {
    await lockUserLifecycle(transaction, input.projectRef, userId);
    const fence = await deletionFence(transaction, input.projectRef, userId);
    if (
      !fence ||
      fence.operation_id !== reconciledOperationId ||
      fence.operation_active ||
      (fence.status !== "requested" && fence.status !== "deleting")
    ) {
      return { state: "operation_changed" as const };
    }

    const taskSafety = await activeTasks(input.projectRef, userId, transaction);
    if (!taskSafety.safe) return { state: "blocked" as const, ...taskSafety };

    const operationId = randomUUID();
    const rows = await transaction`
      UPDATE project_user_deletion_fences
      SET status = 'requested',
          should_soft_delete = ${input.shouldSoftDelete},
          request_id = ${input.requestId},
          operation_id = ${operationId}::uuid,
          operation_expires_at = NOW() + INTERVAL '5 minutes',
          last_error = NULL,
          requested_at = NOW(),
          deletion_started_at = NULL,
          completed_at = NULL,
          updated_at = NOW()
      WHERE project_ref = ${input.projectRef}
        AND user_id = ${userId}::uuid
        AND operation_id = ${reconciledOperationId}::uuid
        AND status IN ('requested', 'deleting')
      RETURNING id
    `;
    if (rows.length === 0) return { state: "operation_changed" as const };
    return { state: "ready" as const, normalizedUserId: userId, operationId };
  });
}

export async function markUserDeletionStarted(input: UserDeletionOperationInput): Promise<void> {
  const rows = await sql`
    UPDATE project_user_deletion_fences
    SET status = 'deleting',
        deletion_started_at = NOW(),
        operation_expires_at = NOW() + INTERVAL '5 minutes',
        updated_at = NOW()
    WHERE project_ref = ${input.projectRef}
      AND user_id = ${input.userId}::uuid
      AND operation_id = ${input.operationId}::uuid
      AND status = 'requested'
      AND operation_expires_at > NOW()
    RETURNING id
  `;
  if (rows.length === 0) throw new Error("GoTrue user deletion fence is no longer owned by this request");
}

export async function completeUserDeletion(input: UserDeletionOperationInput): Promise<void> {
  const rows = await sql`
    UPDATE project_user_deletion_fences
    SET status = 'deleted',
        last_error = NULL,
        completed_at = NOW(),
        updated_at = NOW()
    WHERE project_ref = ${input.projectRef}
      AND user_id = ${input.userId}::uuid
      AND operation_id = ${input.operationId}::uuid
      AND status IN ('requested', 'deleting')
    RETURNING id
  `;
  if (rows.length === 0) throw new Error("GoTrue user deletion completion could not be persisted");
}

export async function recordUserDeletionUncertainty(
  input: UserDeletionOperationInput,
  error: string,
): Promise<boolean> {
  const rows = await sql`
    UPDATE project_user_deletion_fences
    SET last_error = ${error},
        updated_at = NOW()
    WHERE project_ref = ${input.projectRef}
      AND user_id = ${input.userId}::uuid
      AND operation_id = ${input.operationId}::uuid
      AND status IN ('requested', 'deleting')
    RETURNING id
  `;
  return rows.length > 0;
}

export async function failUserDeletion(input: UserDeletionOperationInput, error: string): Promise<boolean> {
  const rows = await sql`
    UPDATE project_user_deletion_fences
    SET status = 'failed',
        last_error = ${error},
        updated_at = NOW()
    WHERE project_ref = ${input.projectRef}
      AND user_id = ${input.userId}::uuid
      AND operation_id = ${input.operationId}::uuid
      AND status IN ('requested', 'deleting')
    RETURNING id
  `;
  return rows.length > 0;
}
