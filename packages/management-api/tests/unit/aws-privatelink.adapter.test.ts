import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  AWS_PRIVATELINK_CREDENTIALS_REJECTED,
  AWS_PRIVATELINK_PROVIDER_UNAVAILABLE,
  PRIVATE_LINK_ACTIONS,
  PRIVATE_LINK_INPUT_INVALID,
  PrivateLinkInputError,
  createUnavailableAwsPrivateLinkProvider,
  parsePrivateLinkAttachment,
  planPrivateLinkApply,
} from "../../src/services/aws-privatelink.adapter";

const attachment = {
  projectRef: "proj_alpha",
  region: "us-east-1",
  vpcId: "vpc-0123456789abcdef0",
  subnetIds: ["subnet-0123456789abcdef0", "subnet-abcdef0123456789"],
  allowedPrincipalArns: ["arn:aws:iam::123456789012:root"],
  consumerEndpointIds: ["vpce-0123456789abcdef0"],
  target: { host: "pooler.internal", port: 6543 },
};

function throwingTransport() {
  return {
    calls: 0,
    invoke(action: string) {
      this.calls += 1;
      throw new Error(`AWS transport invoked for ${action}`);
    },
  };
}

describe("AWS PrivateLink adapter", () => {
  test("plans one attachment and does not assign an endpoint service", () => {
    const plan = planPrivateLinkApply(parsePrivateLinkAttachment(attachment));

    expect(plan.operation).toBe("apply");
    expect(plan.region).toBe("us-east-1");
    expect(plan.acceptanceRequired).toBe(true);
    expect(plan.endpointServiceName).toBeNull();
    expect(plan.endpointServiceId).toBeNull();
    expect(plan.privateDnsName).toBeNull();
    expect(plan.awsApiCalls).toEqual([]);
    expect(plan.listener).toEqual({ host: "pooler.internal", port: 6543 });
    expect(plan.resources.map((resource) => resource.action)).toEqual([
      PRIVATE_LINK_ACTIONS.createLoadBalancer,
      PRIVATE_LINK_ACTIONS.createTargetGroup,
      PRIVATE_LINK_ACTIONS.registerTargets,
      PRIVATE_LINK_ACTIONS.createEndpointService,
      PRIVATE_LINK_ACTIONS.modifyPermissions,
      PRIVATE_LINK_ACTIONS.acceptConnections,
    ]);
    expect(plan.resources.every((resource) => resource.invoked === false)).toBe(true);
    expect(plan.resources[0]?.proposedName).toBe("sc-pl-proj-alpha");
    expect(plan.resources[1]?.proposedName).toBe("sc-pl-tg-proj-alpha");
    expect(JSON.stringify(plan)).not.toContain("vpce-svc");
    expect(JSON.stringify(plan)).not.toContain("amazonaws.com");
  });

  test("unavailable provider fails closed and never calls the transport", () => {
    const transport = throwingTransport();
    const provider = createUnavailableAwsPrivateLinkProvider(transport);
    const applied = provider.apply(attachment);
    const described = provider.describe({ projectRef: attachment.projectRef });
    const accepted = provider.acceptConsumer({
      projectRef: attachment.projectRef,
      region: attachment.region,
      consumerEndpointIds: attachment.consumerEndpointIds,
    });
    const rejected = provider.rejectConsumer({
      projectRef: attachment.projectRef,
      region: attachment.region,
      consumerEndpointIds: attachment.consumerEndpointIds,
    });
    const removed = provider.remove({ projectRef: attachment.projectRef, region: attachment.region });

    for (const result of [applied, described, accepted, rejected, removed]) {
      expect(result).toMatchObject({
        ok: false,
        code: AWS_PRIVATELINK_PROVIDER_UNAVAILABLE,
        status: "not_provisioned",
        provider: "unavailable",
        deployed: false,
        awsApiCalls: [],
      });
      expect(result.plan.awsApiCalls).toEqual([]);
      expect(result.plan.resources.every((resource) => resource.invoked === false)).toBe(true);
      expect(result.plan.endpointServiceName).toBeNull();
    }
    expect(described.plan.region).toBeNull();
    expect(described.plan.resources.map((resource) => resource.action)).toEqual([
      PRIVATE_LINK_ACTIONS.describeServices,
      PRIVATE_LINK_ACTIONS.describeConnections,
    ]);
    expect(rejected.plan.resources[0]?.action).toBe(PRIVATE_LINK_ACTIONS.rejectConnections);
    expect(removed.plan.resources.map((resource) => resource.action)).toEqual([
      PRIVATE_LINK_ACTIONS.deleteEndpointService,
      PRIVATE_LINK_ACTIONS.deleteLoadBalancer,
      PRIVATE_LINK_ACTIONS.deleteTargetGroup,
    ]);
    expect(transport.calls).toBe(0);
    expect(Object.isFrozen(applied)).toBe(true);
    expect(Object.isFrozen(applied.plan.resources)).toBe(true);
  });

  test("rejects credential fields before building a plan", () => {
    const transport = throwingTransport();
    const provider = createUnavailableAwsPrivateLinkProvider(transport);
    const planted = {
      ...attachment,
      target: { ...attachment.target, accessKeyId: "should-not-be-read", secretAccessKey: "should-not-be-read" },
    };

    expect(() => provider.apply(planted)).toThrow(PrivateLinkInputError);
    try {
      provider.apply(planted);
    } catch (error) {
      expect(error).toBeInstanceOf(PrivateLinkInputError);
      expect((error as PrivateLinkInputError).code).toBe(AWS_PRIVATELINK_CREDENTIALS_REJECTED);
      expect((error as Error).message).toBe("Credential fields are not accepted");
      expect((error as Error).message).not.toContain("should-not-be-read");
    }
    expect(transport.calls).toBe(0);
  });

  test("rejects malformed identifiers, wildcards, and invented endpoint hosts", () => {
    expect(() => parsePrivateLinkAttachment({ ...attachment, vpcId: "vpc-live" })).toThrow(PrivateLinkInputError);
    expect(() => parsePrivateLinkAttachment({
      ...attachment,
      allowedPrincipalArns: ["*"],
    })).toThrow(PrivateLinkInputError);
    expect(() => parsePrivateLinkAttachment({
      ...attachment,
      subnetIds: ["subnet-0123456789abcdef0", "subnet-0123456789abcdef0"],
    })).toThrow(PrivateLinkInputError);
    expect(() => parsePrivateLinkAttachment({
      ...attachment,
      region: "https://ec2.us-east-1.amazonaws.com",
    })).toThrow(PrivateLinkInputError);
    expect(() => parsePrivateLinkAttachment({
      ...attachment,
      target: { host: "vpce-svc-0123456789abcdef0.us-east-1.vpce.amazonaws.com", port: 5432 },
    })).toThrow(PrivateLinkInputError);
    expect(() => parsePrivateLinkAttachment({
      ...attachment,
      endpointServiceName: "com.amazonaws.vpce.us-east-1.vpce-svc-01234567",
    })).toThrow(PrivateLinkInputError);

    try {
      parsePrivateLinkAttachment({ ...attachment, vpcId: "not-a-vpc" });
    } catch (error) {
      expect((error as PrivateLinkInputError).code).toBe(PRIVATE_LINK_INPUT_INVALID);
      expect((error as Error).message).not.toContain("not-a-vpc");
    }
  });

  test("adapter source does not call AWS or read credentials", () => {
    const source = readFileSync(
      new URL("../../src/services/aws-privatelink.adapter.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/https?:\/\//);
    expect(source).not.toContain("aws4fetch");
    expect(source).not.toContain("AWS_ACCESS_KEY");
    expect(source).not.toContain("AWS_SECRET");
    expect(source).not.toContain("process.env");
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("Bun.");
    expect(source).not.toContain('from "bun"');
    expect(source).toContain('dotted.endsWith(".amazonaws.com")');
  });
});
