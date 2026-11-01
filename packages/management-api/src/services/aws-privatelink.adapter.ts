/**
 * AWS PrivateLink adapter for one project attachment in one region.
 *
 * The shipped provider validates a desired attachment and returns a plan.
 * It does not call AWS, read credentials, or assign an endpoint service name.
 * A future operator-configured provider would create the resources listed in
 * `planPrivateLinkApply`. This module leaves that work uninvoked.
 */

export const AWS_PRIVATELINK_PROVIDER_UNAVAILABLE = "AWS_PRIVATELINK_PROVIDER_UNAVAILABLE";
export const AWS_PRIVATELINK_CREDENTIALS_REJECTED = "AWS_PRIVATELINK_CREDENTIALS_REJECTED";
export const PRIVATE_LINK_INPUT_INVALID = "PRIVATE_LINK_INPUT_INVALID";

/** IAM-style action names a real provider would call. None are invoked here. */
export const PRIVATE_LINK_ACTIONS = {
  createLoadBalancer: "elasticloadbalancing:CreateLoadBalancer",
  createTargetGroup: "elasticloadbalancing:CreateTargetGroup",
  registerTargets: "elasticloadbalancing:RegisterTargets",
  createEndpointService: "ec2:CreateVpcEndpointServiceConfiguration",
  modifyPermissions: "ec2:ModifyVpcEndpointServicePermissions",
  acceptConnections: "ec2:AcceptVpcEndpointConnections",
  rejectConnections: "ec2:RejectVpcEndpointConnections",
  describeServices: "ec2:DescribeVpcEndpointServiceConfigurations",
  describeConnections: "ec2:DescribeVpcEndpointConnections",
  deleteEndpointService: "ec2:DeleteVpcEndpointServiceConfigurations",
  deleteLoadBalancer: "elasticloadbalancing:DeleteLoadBalancer",
  deleteTargetGroup: "elasticloadbalancing:DeleteTargetGroup",
} as const;

const PROJECT_REF_PATTERN = /^[A-Za-z0-9_-]{1,20}$/;
const REGION_PATTERN = /^(?:[a-z]{2}-[a-z]+-\d+|us-gov-[a-z]+-\d+|cn-[a-z]+-\d+)$/;
const VPC_ID_PATTERN = /^vpc-[0-9a-f]{8,17}$/;
const SUBNET_ID_PATTERN = /^subnet-[0-9a-f]{8,17}$/;
const ENDPOINT_ID_PATTERN = /^vpce-[0-9a-f]{8,17}$/;
const PRINCIPAL_ARN_PATTERN = /^arn:aws:iam::\d{12}:(?:root|user\/[A-Za-z0-9+=,.@_-]{1,64}|role\/[A-Za-z0-9+=,.@_/-]{1,64})$/;
const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;
const IPV4_PATTERN = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

const ATTACHMENT_FIELDS = new Set([
  "projectRef",
  "region",
  "vpcId",
  "subnetIds",
  "allowedPrincipalArns",
  "consumerEndpointIds",
  "target",
]);
const TARGET_FIELDS = new Set(["host", "port"]);
const REMOVAL_FIELDS = new Set(["projectRef", "region"]);
const CONSUMER_FIELDS = new Set(["projectRef", "region", "consumerEndpointIds"]);
const DESCRIBE_FIELDS = new Set(["projectRef"]);

const FORBIDDEN_KEY_NAMES = new Set([
  "accesskeyid",
  "secretaccesskey",
  "sessiontoken",
  "credentials",
  "awsaccesskeyid",
  "awssecretaccesskey",
  "awssessiontoken",
  "awsaccesskey",
  "awssecretkey",
]);

export type PrivateLinkOperation = "describe" | "apply" | "accept" | "reject" | "remove";

export type PrivateLinkResourceKind =
  | "network_load_balancer"
  | "target_group"
  | "target_registration"
  | "vpc_endpoint_service"
  | "allowed_principals"
  | "consumer_acceptance"
  | "consumer_rejection"
  | "service_description"
  | "connection_description"
  | "endpoint_service_deletion"
  | "load_balancer_deletion"
  | "target_group_deletion";

export interface PrivateLinkListener {
  host: string;
  port: number;
}

export interface PrivateLinkAttachmentInput {
  projectRef: string;
  region: string;
  vpcId: string;
  subnetIds: readonly string[];
  allowedPrincipalArns: readonly string[];
  consumerEndpointIds: readonly string[];
  target: PrivateLinkListener;
}

export interface PrivateLinkResourceIntent {
  kind: PrivateLinkResourceKind;
  /** AWS API action that would be called. This adapter does not call it. */
  action: string;
  invoked: false;
  /** Local label only. AWS has not created a resource with this name. */
  proposedName: string | null;
}

export interface PrivateLinkPlan {
  operation: PrivateLinkOperation;
  projectRef: string;
  region: string | null;
  acceptanceRequired: true;
  /** Unassigned. AWS would return this after a create call, which is not made. */
  endpointServiceName: null;
  endpointServiceId: null;
  privateDnsName: null;
  listener: PrivateLinkListener | null;
  consumerEndpointIds: readonly string[];
  resources: readonly PrivateLinkResourceIntent[];
  awsApiCalls: readonly [];
}

export interface PrivateLinkOperationResult {
  ok: false;
  code: typeof AWS_PRIVATELINK_PROVIDER_UNAVAILABLE;
  status: "not_provisioned";
  provider: "unavailable";
  deployed: false;
  plan: PrivateLinkPlan;
  awsApiCalls: readonly [];
}

export interface AwsApiTransport {
  invoke(action: string, parameters: Readonly<Record<string, string>>): Promise<unknown>;
}

export interface AwsPrivateLinkProvider {
  readonly mode: "unavailable";
  describe(value: unknown): PrivateLinkOperationResult;
  apply(value: unknown): PrivateLinkOperationResult;
  acceptConsumer(value: unknown): PrivateLinkOperationResult;
  rejectConsumer(value: unknown): PrivateLinkOperationResult;
  remove(value: unknown): PrivateLinkOperationResult;
}

export class PrivateLinkInputError extends Error {
  readonly code: typeof PRIVATE_LINK_INPUT_INVALID | typeof AWS_PRIVATELINK_CREDENTIALS_REJECTED;

  constructor(
    code: typeof PRIVATE_LINK_INPUT_INVALID | typeof AWS_PRIVATELINK_CREDENTIALS_REJECTED,
    message: string,
  ) {
    super(message);
    this.name = "PrivateLinkInputError";
    this.code = code;
  }
}

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
}

function rejectCredentialKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) rejectCredentialKeys(entry);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEY_NAMES.has(normalizedKey(key))) {
      throw new PrivateLinkInputError(
        AWS_PRIVATELINK_CREDENTIALS_REJECTED,
        "Credential fields are not accepted",
      );
    }
    rejectCredentialKeys(child);
  }
}

function invalid(message: string): never {
  throw new PrivateLinkInputError(PRIVATE_LINK_INPUT_INVALID, message);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`);
  rejectCredentialKeys(value);
  return value as Record<string, unknown>;
}

function rejectUnknownFields(record: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) invalid(`${label} contains an unexpected field`);
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    invalid(`${label} must be a non-empty string`);
  }
  return value;
}

function requireUniqueIds(value: unknown, pattern: RegExp, label: string, min: number, max: number): string[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  if (value.length < min || value.length > max) invalid(`${label} must contain ${min} to ${max} entries`);
  const ids: string[] = [];
  for (const entry of value) {
    const id = requireString(entry, label);
    if (!pattern.test(id)) invalid(`${label} has an invalid id`);
    ids.push(id);
  }
  if (new Set(ids).size !== ids.length) invalid(`${label} contains a duplicate`);
  return ids;
}

function requireProjectRef(value: unknown): string {
  const projectRef = requireString(value, "projectRef");
  if (!PROJECT_REF_PATTERN.test(projectRef)) invalid("projectRef is invalid");
  return projectRef;
}

function requireRegion(value: unknown): string {
  const region = requireString(value, "region");
  if (!REGION_PATTERN.test(region)) invalid("region is invalid");
  return region;
}

function requireListener(value: unknown): PrivateLinkListener {
  const record = requireRecord(value, "target");
  rejectUnknownFields(record, TARGET_FIELDS, "target");
  const host = requireString(record.host, "target.host").toLowerCase();
  if (host.includes("://") || host.includes("/") || host.includes(":")) invalid("target.host is invalid");
  const dotted = host.endsWith(".") ? host.slice(0, -1) : host;
  if (dotted === "amazonaws.com" || dotted.endsWith(".amazonaws.com") || dotted.includes("vpce-svc")) {
    invalid("target.host must be the project listener, not an AWS endpoint name");
  }
  if (!IPV4_PATTERN.test(dotted) && !HOSTNAME_PATTERN.test(dotted)) invalid("target.host is invalid");
  if (typeof record.port !== "number" || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535) {
    invalid("target.port is invalid");
  }
  return { host: dotted, port: record.port };
}

export function parsePrivateLinkAttachment(value: unknown): PrivateLinkAttachmentInput {
  const record = requireRecord(value, "attachment");
  rejectUnknownFields(record, ATTACHMENT_FIELDS, "attachment");
  const consumerEndpointIds = record.consumerEndpointIds === undefined
    ? []
    : requireUniqueIds(record.consumerEndpointIds, ENDPOINT_ID_PATTERN, "consumerEndpointIds", 0, 20);
  const vpcId = requireString(record.vpcId, "vpcId");
  if (!VPC_ID_PATTERN.test(vpcId)) invalid("vpcId is invalid");
  return {
    projectRef: requireProjectRef(record.projectRef),
    region: requireRegion(record.region),
    vpcId,
    subnetIds: requireUniqueIds(record.subnetIds, SUBNET_ID_PATTERN, "subnetIds", 1, 3),
    allowedPrincipalArns: requireUniqueIds(
      record.allowedPrincipalArns,
      PRINCIPAL_ARN_PATTERN,
      "allowedPrincipalArns",
      1,
      8,
    ),
    consumerEndpointIds,
    target: requireListener(record.target),
  };
}

export function parsePrivateLinkDescribe(value: unknown): { projectRef: string } {
  const record = requireRecord(value, "describe");
  rejectUnknownFields(record, DESCRIBE_FIELDS, "describe");
  return { projectRef: requireProjectRef(record.projectRef) };
}

export function parsePrivateLinkRemoval(value: unknown): { projectRef: string; region: string } {
  const record = requireRecord(value, "removal");
  rejectUnknownFields(record, REMOVAL_FIELDS, "removal");
  return { projectRef: requireProjectRef(record.projectRef), region: requireRegion(record.region) };
}

export function parsePrivateLinkConsumerChange(value: unknown): {
  projectRef: string;
  region: string;
  consumerEndpointIds: string[];
} {
  const record = requireRecord(value, "consumer change");
  rejectUnknownFields(record, CONSUMER_FIELDS, "consumer change");
  return {
    projectRef: requireProjectRef(record.projectRef),
    region: requireRegion(record.region),
    consumerEndpointIds: requireUniqueIds(
      record.consumerEndpointIds,
      ENDPOINT_ID_PATTERN,
      "consumerEndpointIds",
      1,
      20,
    ),
  };
}

function proposedLoadBalancerName(projectRef: string): string {
  return `sc-pl-${projectRef.toLowerCase().replaceAll("_", "-")}`.slice(0, 32);
}

function proposedTargetGroupName(projectRef: string): string {
  return `sc-pl-tg-${projectRef.toLowerCase().replaceAll("_", "-")}`.slice(0, 32);
}

function intent(
  kind: PrivateLinkResourceKind,
  action: string,
  proposedName: string | null,
): PrivateLinkResourceIntent {
  return { kind, action, invoked: false, proposedName };
}

function seal<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) {
      if (entry && typeof entry === "object") seal(entry);
    }
    Object.freeze(value);
  }
  return value;
}

function planBase(
  operation: PrivateLinkOperation,
  projectRef: string,
  region: string | null,
  resources: PrivateLinkResourceIntent[],
  listener: PrivateLinkListener | null,
  consumerEndpointIds: readonly string[],
): PrivateLinkPlan {
  return seal({
    operation,
    projectRef,
    region,
    acceptanceRequired: true,
    endpointServiceName: null,
    endpointServiceId: null,
    privateDnsName: null,
    listener: listener ? { host: listener.host, port: listener.port } : null,
    consumerEndpointIds: [...consumerEndpointIds],
    resources,
    awsApiCalls: [],
  });
}

export function planPrivateLinkDescribe(projectRef: string): PrivateLinkPlan {
  return planBase("describe", projectRef, null, [
    intent("service_description", PRIVATE_LINK_ACTIONS.describeServices, null),
    intent("connection_description", PRIVATE_LINK_ACTIONS.describeConnections, null),
  ], null, []);
}

export function planPrivateLinkApply(input: PrivateLinkAttachmentInput): PrivateLinkPlan {
  const resources = [
    intent("network_load_balancer", PRIVATE_LINK_ACTIONS.createLoadBalancer, proposedLoadBalancerName(input.projectRef)),
    intent("target_group", PRIVATE_LINK_ACTIONS.createTargetGroup, proposedTargetGroupName(input.projectRef)),
    intent("target_registration", PRIVATE_LINK_ACTIONS.registerTargets, null),
    intent("vpc_endpoint_service", PRIVATE_LINK_ACTIONS.createEndpointService, null),
    intent("allowed_principals", PRIVATE_LINK_ACTIONS.modifyPermissions, null),
  ];
  if (input.consumerEndpointIds.length > 0) {
    resources.push(intent("consumer_acceptance", PRIVATE_LINK_ACTIONS.acceptConnections, null));
  }
  return planBase(
    "apply",
    input.projectRef,
    input.region,
    resources,
    input.target,
    input.consumerEndpointIds,
  );
}

export function planPrivateLinkAccept(input: {
  projectRef: string;
  region: string;
  consumerEndpointIds: readonly string[];
}): PrivateLinkPlan {
  return planBase("accept", input.projectRef, input.region, [
    intent("consumer_acceptance", PRIVATE_LINK_ACTIONS.acceptConnections, null),
  ], null, input.consumerEndpointIds);
}

export function planPrivateLinkReject(input: {
  projectRef: string;
  region: string;
  consumerEndpointIds: readonly string[];
}): PrivateLinkPlan {
  return planBase("reject", input.projectRef, input.region, [
    intent("consumer_rejection", PRIVATE_LINK_ACTIONS.rejectConnections, null),
  ], null, input.consumerEndpointIds);
}

export function planPrivateLinkRemove(input: { projectRef: string; region: string }): PrivateLinkPlan {
  return planBase("remove", input.projectRef, input.region, [
    intent("endpoint_service_deletion", PRIVATE_LINK_ACTIONS.deleteEndpointService, null),
    intent("load_balancer_deletion", PRIVATE_LINK_ACTIONS.deleteLoadBalancer, proposedLoadBalancerName(input.projectRef)),
    intent("target_group_deletion", PRIVATE_LINK_ACTIONS.deleteTargetGroup, proposedTargetGroupName(input.projectRef)),
  ], null, []);
}

function unavailable(plan: PrivateLinkPlan): PrivateLinkOperationResult {
  return seal({
    ok: false,
    code: AWS_PRIVATELINK_PROVIDER_UNAVAILABLE,
    status: "not_provisioned",
    provider: "unavailable",
    deployed: false,
    plan,
    awsApiCalls: [],
  });
}

/**
 * Provider that plans a PrivateLink attachment and fails closed.
 * `transport` is accepted so a later provider can share this factory shape.
 * This implementation discards it and performs no network call.
 */
export function createUnavailableAwsPrivateLinkProvider(
  transport: AwsApiTransport | null = null,
): AwsPrivateLinkProvider {
  void transport;
  return {
    mode: "unavailable",
    describe(value: unknown) {
      const input = parsePrivateLinkDescribe(value);
      return unavailable(planPrivateLinkDescribe(input.projectRef));
    },
    apply(value: unknown) {
      return unavailable(planPrivateLinkApply(parsePrivateLinkAttachment(value)));
    },
    acceptConsumer(value: unknown) {
      return unavailable(planPrivateLinkAccept(parsePrivateLinkConsumerChange(value)));
    },
    rejectConsumer(value: unknown) {
      return unavailable(planPrivateLinkReject(parsePrivateLinkConsumerChange(value)));
    },
    remove(value: unknown) {
      return unavailable(planPrivateLinkRemove(parsePrivateLinkRemoval(value)));
    },
  };
}

export const unavailableAwsPrivateLink = createUnavailableAwsPrivateLinkProvider();
