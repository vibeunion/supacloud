# AWS PrivateLink adapter

Status: local integration surface in the management API. **Not deployed.** No AWS resource is created, and no endpoint service name is assigned.

This is one attachment in one region. It is not a multi-region deployment.

Network restrictions (`/:ref/network-restrictions`) remain a CIDR allowlist on the project gateway. They do not create a VPC endpoint service.

## Integration surface

`packages/management-api/src/services/aws-privatelink.adapter.ts`

- `parsePrivateLinkAttachment`, `parsePrivateLinkDescribe`, `parsePrivateLinkRemoval`, `parsePrivateLinkConsumerChange` validate caller input.
- `planPrivateLinkApply`, `planPrivateLinkDescribe`, `planPrivateLinkAccept`, `planPrivateLinkReject`, and `planPrivateLinkRemove` describe the AWS work.
- `createUnavailableAwsPrivateLinkProvider` is the provider that ships. `describe`, `apply`, `acceptConsumer`, `rejectConsumer`, and `remove` return `ok: false`, `code: AWS_PRIVATELINK_PROVIDER_UNAVAILABLE`, `status: not_provisioned`, `deployed: false`, and `awsApiCalls: []`.

The factory accepts an `AwsApiTransport` argument so a later provider can share the same shape. The unavailable provider discards that argument and does not invoke it.

No management HTTP route, project-config record, or CLI command is mounted. Callers that need a route should keep returning this unavailable result until a provider is configured outside this repository.

## What would be created

A later provider, configured by an operator with credentials that are not stored here, would request the following for one project, one region, the supplied VPC, and one to three subnets:

| Intent | AWS action that would be called | What it would create |
|---|---|---|
| Network Load Balancer | `elasticloadbalancing:CreateLoadBalancer` | An NLB in the given subnets. The plan carries a local label `sc-pl-<project-ref>`. That label is not an AWS resource id. |
| Target group | `elasticloadbalancing:CreateTargetGroup` | A target group for the caller-supplied project listener host and port. Local label `sc-pl-tg-<project-ref>`. |
| Target registration | `elasticloadbalancing:RegisterTargets` | Registration of that listener. Reachability is not checked. |
| VPC endpoint service | `ec2:CreateVpcEndpointServiceConfiguration` | An interface endpoint service backed by the NLB, with connection acceptance required. |
| Allowed principals | `ec2:ModifyVpcEndpointServicePermissions` | Permission for the supplied IAM principals (`arn:aws:iam::<account>:root`, user, or role). `*` is rejected. |
| Consumer acceptance | `ec2:AcceptVpcEndpointConnections` | Acceptance of caller-supplied consumer `vpce-` ids, when the attachment includes them. |
| Consumer rejection | `ec2:RejectVpcEndpointConnections` | Rejection of caller-supplied consumer `vpce-` ids. |
| Removal | `ec2:DeleteVpcEndpointServiceConfigurations`, `elasticloadbalancing:DeleteLoadBalancer`, `elasticloadbalancing:DeleteTargetGroup` | Deletion of the service, NLB, and target group. |

AWS would assign the endpoint service name, service id, and any private DNS name after the create call. Those fields stay `null` in every plan. This adapter does not invent a `vpce-svc-` id or a DNS name.

The consumer VPC endpoint itself would be created in the customer's account. This adapter does not plan that create.

## What is not called

The unavailable provider does not invoke any of the actions above, and it also does not invoke:

- `ec2:DescribeVpcEndpointServiceConfigurations`
- `ec2:DescribeVpcEndpointConnections`
- Route 53 private DNS verification
- STS or any credential provider

`awsApiCalls` is always `[]`. Each plan resource has `invoked: false`.

Credential fields (`accessKeyId`, `secretAccessKey`, `sessionToken`, `credentials`, and the `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` names) are rejected with `AWS_PRIVATELINK_CREDENTIALS_REJECTED` before a plan is built. The module does not read `process.env`.

## Gaps

- No live AWS account, region endpoint, or endpoint service is configured.
- No credentials are read or stored.
- Plans are not persisted, and nothing reconciles them.
- The project listener is not registered with a load balancer.
- Private DNS is not requested.
- Customer-side endpoint, security group, and hosted-zone steps are out of scope.
- Principals are commercial-partition IAM ARNs (`arn:aws:iam::...`) only. `aws-us-gov` and `aws-cn` partitions are rejected.
- Describe cannot report an existing service, because none is created. It returns `not_provisioned` with `region: null`.
