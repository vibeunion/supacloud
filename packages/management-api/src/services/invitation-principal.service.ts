import { getProjectDb, resolveDbName } from "../db";
import { AuthError, ForbiddenError } from "../utils/errors";
import { verifyProjectJwtPayload } from "../utils/project-jwt";
import { getAuthRuntimeDescriptor } from "./auth-runtime.service";
import { registerVerifiedAuditPrincipal } from "./request-audit-principal.service";

export type InvitationPrincipal = {
  id: string;
  email: string;
};

function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) {
    throw new AuthError("A GoTrue user access token is required");
  }
  const token = authorization.slice(7).trim();
  if (!token) throw new AuthError("A GoTrue user access token is required");
  return token;
}

export async function resolveInvitationPrincipal(
  request: Request,
  projectRef: string,
): Promise<InvitationPrincipal> {
  const verification = await verifyProjectJwtPayload(projectRef, bearerToken(request));
  const subject = verification?.payload.sub;
  if (verification?.payload.role !== "authenticated" || typeof subject !== "string") {
    throw new ForbiddenError("Only an authenticated GoTrue user can accept an invitation");
  }

  const authorityRef = getAuthRuntimeDescriptor(projectRef).authority_project_ref;
  const tenantDb = getProjectDb(await resolveDbName(authorityRef));
  const [user] = await tenantDb`
    SELECT id::text AS id, lower(email) AS email
    FROM auth.users
    WHERE id::text = ${subject} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!user || typeof user.email !== "string" || !user.email) {
    throw new ForbiddenError("The authenticated GoTrue user has no verified invitation email");
  }
  const principal = { id: String(user.id), email: user.email };
  registerVerifiedAuditPrincipal(request, { id: principal.id, type: "user" });
  return principal;
}
