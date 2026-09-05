const ACTIVATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const POSITIVE_VERSION_PATTERN = /^[1-9][0-9]*$/;
const CANONICAL_VERSION_PATTERN = /^(?:0|[1-9][0-9]*)$/;

type FunctionIdentityExpectation = {
  projectRef: string;
  slug: string;
};

type FunctionMutationExpectation = FunctionIdentityExpectation & {
  expectedActivationId: string;
};

type VersionedMutationExpectation = FunctionMutationExpectation & {
  previousActiveVersion: string;
  targetVersion: string;
};

type ConfirmedMutationIdentity = {
  receipt: Record<string, unknown>;
  activationId: string;
};

export type AbsentFunctionIdentity = {
  activationId: string;
  verifyJwt: boolean;
  backgroundRoutes: string[];
};

export type FunctionVersionMutationReceipt = {
  activationId: string;
  activeVersion: string;
  verifyJwt: boolean;
};

export type FunctionConfigMutationReceipt = {
  activationId: string;
  verifyJwt: boolean;
};

function record(candidate: unknown): Record<string, unknown> | null {
  return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
    ? toRecord(candidate)
    : null;
}

function toRecord(value: object): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) result[key] = item;
  return result;
}

export function isObservedFunctionActivationId(candidate: unknown): candidate is string {
  return candidate === "legacy"
    || (typeof candidate === "string" && ACTIVATION_ID_PATTERN.test(candidate));
}

function validCommittedActivationId(candidate: unknown): candidate is string {
  return typeof candidate === "string" && ACTIVATION_ID_PATTERN.test(candidate);
}

function canonicalVersion(candidate: unknown): candidate is string {
  return typeof candidate === "string"
    && CANONICAL_VERSION_PATTERN.test(candidate)
    && Number.isSafeInteger(Number(candidate));
}

function positiveVersion(candidate: unknown): candidate is string {
  return canonicalVersion(candidate) && POSITIVE_VERSION_PATTERN.test(candidate);
}

function stringRoutes(candidate: unknown): candidate is string[] {
  return Array.isArray(candidate) && candidate.every((route: unknown) => typeof route === "string");
}

function invalidReceipt(): never {
  throw new Error("Invalid Edge Function mutation response");
}

function confirmedMutationIdentity(
  payload: unknown,
  expectation: FunctionMutationExpectation,
): ConfirmedMutationIdentity {
  const receipt = record(payload);
  const activationId = receipt?.activation_id;
  if (!receipt
    || receipt.success !== true
    || receipt.project_ref !== expectation.projectRef
    || receipt.slug !== expectation.slug
    || receipt.expected_activation_id !== expectation.expectedActivationId
    || !validCommittedActivationId(activationId)
    || activationId === expectation.expectedActivationId) return invalidReceipt();
  return { receipt, activationId };
}

function confirmedVersionedMutation(
  payload: unknown,
  expectation: VersionedMutationExpectation,
): FunctionVersionMutationReceipt {
  const { receipt, activationId } = confirmedMutationIdentity(payload, expectation);
  const config = record(receipt.config);
  if (!config
    || receipt.previous_active_version !== expectation.previousActiveVersion
    || receipt.active_version !== expectation.targetVersion
    || receipt.version !== expectation.targetVersion
    || config.version !== expectation.targetVersion
    || config.activation_id !== activationId
    || typeof config.verify_jwt !== "boolean") return invalidReceipt();
  return {
    activationId,
    activeVersion: expectation.targetVersion,
    verifyJwt: config.verify_jwt,
  };
}

export function parseAbsentFunctionIdentity(
  payload: unknown,
  expectation: FunctionIdentityExpectation,
): AbsentFunctionIdentity {
  const identity = record(payload);
  if (!identity
    || identity.project_ref !== expectation.projectRef
    || identity.slug !== expectation.slug
    || identity.active_version !== "absent"
    || !isObservedFunctionActivationId(identity.activation_id)
    || identity.version !== undefined
    || typeof identity.verify_jwt !== "boolean"
    || !stringRoutes(identity.background_routes)) return invalidReceipt();
  return {
    activationId: identity.activation_id,
    verifyJwt: identity.verify_jwt,
    backgroundRoutes: identity.background_routes,
  };
}

export function parseFunctionCreateReceipt(
  payload: unknown,
  expectation: FunctionMutationExpectation,
): FunctionVersionMutationReceipt {
  const receipt = record(payload);
  const targetVersion = receipt?.active_version;
  if (!positiveVersion(targetVersion)) return invalidReceipt();
  return confirmedVersionedMutation(payload, {
    ...expectation,
    previousActiveVersion: "absent",
    targetVersion,
  });
}

export function parseFunctionActivationReceipt(
  payload: unknown,
  expectation: VersionedMutationExpectation,
): FunctionVersionMutationReceipt {
  if (!canonicalVersion(expectation.previousActiveVersion)
    || !positiveVersion(expectation.targetVersion)) return invalidReceipt();
  return confirmedVersionedMutation(payload, expectation);
}

export function parseFunctionDeleteReceipt(
  payload: unknown,
  expectation: FunctionMutationExpectation & { previousActiveVersion: string },
): { activationId: string } {
  if (!canonicalVersion(expectation.previousActiveVersion)) return invalidReceipt();
  const { receipt, activationId } = confirmedMutationIdentity(payload, expectation);
  const config = record(receipt.config);
  if (!config
    || receipt.previous_active_version !== expectation.previousActiveVersion
    || receipt.active_version !== "absent"
    || config.version !== undefined
    || config.activation_id !== activationId
    || typeof config.verify_jwt !== "boolean") return invalidReceipt();
  return { activationId };
}

export function parseFunctionConfigReceipt(
  payload: unknown,
  expectation: FunctionMutationExpectation & { verifyJwt: boolean },
): FunctionConfigMutationReceipt {
  const { receipt, activationId } = confirmedMutationIdentity(payload, expectation);
  if (receipt.verify_jwt !== expectation.verifyJwt
    || !stringRoutes(receipt.background_routes)) return invalidReceipt();
  return { activationId, verifyJwt: receipt.verify_jwt };
}
