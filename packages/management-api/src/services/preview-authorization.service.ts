/**
 * Preview authorization matrix. It is a pure decision function so callers can
 * audit "who may do what" without duplicating policy, and so real credentials
 * and force-deletion stay behind explicit roles/approval.
 */
export type PreviewRole = "member" | "admin" | "ops" | "system";

export type PreviewAction =
  | "view" | "create" | "close" | "reclaim"
  | "full_clone" | "force_delete_bucket" | "use_real_credentials" | "promote_migration";

export interface AuthorizationDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reason: string;
}

const DENIED = (reason: string): AuthorizationDecision => ({ allowed: false, requiresApproval: false, reason });
const ALLOWED = (reason: string): AuthorizationDecision => ({ allowed: true, requiresApproval: false, reason });
const APPROVAL = (reason: string): AuthorizationDecision => ({ allowed: true, requiresApproval: true, reason });

export function authorizePreviewAction(input: {
  action: PreviewAction;
  role: PreviewRole;
  /** Whether the actor created the preview; undefined when not applicable. */
  isOwner?: boolean;
}): AuthorizationDecision {
  const { action, role } = input;
  if (action === "use_real_credentials") return DENIED("Preview never uses real external credentials");

  switch (action) {
    case "view":
      return ALLOWED("Any project role may read a preview");
    case "create":
      return ALLOWED("Any project role may create a preview");
    case "reclaim":
      return ALLOWED("Any project role may reclaim a preview");
    case "close":
      if (role === "member") {
        return input.isOwner === true ? ALLOWED("Members may close their own preview") : DENIED("Members may only close their own preview");
      }
      return ALLOWED("Admins, ops and system may close any preview");
    case "full_clone":
      if (role === "member") return DENIED("full_clone requires an admin");
      if (role === "system") return APPROVAL("system full_clone requires approval");
      return ALLOWED("Admins and ops may request full_clone");
    case "force_delete_bucket":
      if (role === "ops") return ALLOWED("Ops may force-delete a non-empty preview bucket");
      if (role === "system") return APPROVAL("system force-delete requires approval");
      return DENIED("Force-deleting a non-empty bucket requires platform ops");
    case "promote_migration":
      if (role === "member") return DENIED("Migration promotion is not a project role action");
      return APPROVAL("Migration promotion always requires independent approval");
  }
}