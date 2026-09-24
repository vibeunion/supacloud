import {
  createAuthoritativeCommandClient,
  type AuthoritativeCommandContract,
  type AuthoritativeCommandOutcome,
  type AuthoritativeCommandTransport,
} from "@supacloud/js/contracts";

export {
  createAuthoritativeCommandClient,
  createAuthenticatedFetch,
  createCommandScope,
  CommandAuthenticationError,
} from "@supacloud/js/contracts";

type ApprovalInput = { operationId: string; orderId: string };
type ApprovalAcknowledgement = { accepted: boolean };
type ApprovalAuthority = ApprovalInput & { status: "approved" };

export function createApproval(
  contract: AuthoritativeCommandContract<ApprovalInput, ApprovalAcknowledgement, ApprovalAuthority>,
  transport: AuthoritativeCommandTransport<ApprovalInput>,
) {
  const execute = createAuthoritativeCommandClient(contract, transport);
  const checked: (input: unknown) => Promise<
    AuthoritativeCommandOutcome<ApprovalAcknowledgement, ApprovalAuthority>
  > = execute;
  return checked;
}

export function readConfirmedOrder(
  outcome: Awaited<ReturnType<ReturnType<typeof createApproval>>>,
): string | undefined {
  if (outcome.status === "confirmed") {
    if (outcome.acknowledgement.status === "validated") {
      const accepted: boolean = outcome.acknowledgement.value.accepted;
      // @ts-expect-error An acknowledgement payload is not the authoritative order.
      const order: ApprovalAuthority = outcome.acknowledgement.value;
      void accepted;
      void order;
    }
    return outcome.authority.orderId;
  }
  // @ts-expect-error Unknown, denied and invalid outcomes have no confirmed authority.
  const order: ApprovalAuthority = outcome.authority;
  void order;
  return undefined;
}
