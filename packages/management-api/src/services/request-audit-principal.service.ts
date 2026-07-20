export type VerifiedAuditPrincipal = {
  id: string;
  type: string;
};

const verifiedPrincipals = new WeakMap<Request, VerifiedAuditPrincipal>();

export function registerVerifiedAuditPrincipal(
  request: Request,
  principal: VerifiedAuditPrincipal,
): void {
  verifiedPrincipals.set(request, principal);
}

export function verifiedAuditPrincipal(request: Request): VerifiedAuditPrincipal | null {
  return verifiedPrincipals.get(request) || null;
}
