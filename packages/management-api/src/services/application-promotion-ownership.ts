import type { SQL } from "bun";
import { sql } from "../db";
import { stableSha256, stableStringify } from "../utils/stable-json";
import {
  projectMutationResourceKey, readActiveProjectMutationForResource, readProjectMutation,
  withProjectMutationLease,
  type MutationLeaseInput, type MutationPrincipal, type ProjectMutationState,
} from "./project-mutation.service";

export interface ApplicationPromotionScope {
  projectRef: string;
  applicationId: string;
  environmentId: string;
}

/** 未知操作仍阻塞资源；只读恢复观察必须匹配当前完整 journal 和 epoch。 */
export async function assertApplicationPromotionReconciliation(
  scope: ApplicationPromotionScope, expected: ProjectMutationState, database: SQL = sql,
): Promise<void> {
  try {
    const current = await readActiveProjectMutationForResource(scope.projectRef, {
      type: "application_release",
      id: stableSha256({ applicationId: scope.applicationId, environmentId: scope.environmentId }),
    }, database);
    if (!current || expected.status !== "outcome_unknown" || current.operation !== "application.release.promote"
      || current.projectRef !== scope.projectRef || stableStringify(current) !== stableStringify(expected)) {
      throw new ApplicationPromotionOwnershipError();
    }
  } catch { throw new ApplicationPromotionOwnershipError(); }
}

export interface ApplicationPromotionOwner {
  lease: MutationLeaseInput;
  principal: MutationPrincipal;
  requestFingerprint: string;
}

export class ApplicationPromotionOwnershipError extends Error {
  constructor() { super("APPLICATION_PROMOTION_OWNERSHIP_LOST"); }
}

/** 只允许持有精确租约的服务端提升操作重校验目标，不能通过父操作 ID 猜测所有权。 */
export async function assertApplicationPromotionOwner(
  scope: ApplicationPromotionScope,
  owner: ApplicationPromotionOwner,
  database: SQL = sql,
): Promise<void> {
  const input = structuredClone({ scope, owner });
  try {
    if (!/^[a-z0-9-]{1,20}$/.test(input.scope.projectRef)
      || ![input.scope.applicationId, input.scope.environmentId].every(id => /^[A-Za-z0-9_-]{1,64}$/.test(id))
      || !/^[a-f0-9]{64}$/.test(input.owner.requestFingerprint)
      || input.scope.projectRef !== input.owner.lease.projectRef) throw new ApplicationPromotionOwnershipError();
    const resource = {
      type: "application_release",
      id: stableSha256({
        applicationId: input.scope.applicationId, environmentId: input.scope.environmentId,
      }),
    };
    const execution = await database.begin(transaction => withProjectMutationLease(transaction, input.owner.lease, async () => {
      const state = await readProjectMutation(input.owner.lease, transaction);
      if (!state || state.status !== "running" || state.operation !== "application.release.promote"
        || state.projectRef !== input.scope.projectRef || state.mutationId !== input.owner.lease.mutationId
        || state.fencingEpoch !== input.owner.lease.fencingEpoch
        || state.resourceKey !== projectMutationResourceKey(resource)
        || state.requestFingerprint !== input.owner.requestFingerprint
        || stableStringify(state.principal) !== stableStringify(input.owner.principal)) {
        throw new ApplicationPromotionOwnershipError();
      }
      const active = await readActiveProjectMutationForResource(input.scope.projectRef, resource, transaction);
      if (active?.mutationId !== state.mutationId || active.status !== "running") {
        throw new ApplicationPromotionOwnershipError();
      }
    }));
    if (execution.kind !== "executed") throw new ApplicationPromotionOwnershipError();
  } catch {
    // 外部调用者只收到稳定错误码，租约凭据和数据库错误不得进入公开计划。
    throw new ApplicationPromotionOwnershipError();
  }
}
