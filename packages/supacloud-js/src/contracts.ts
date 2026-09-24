// Keep browser command composition separate from the platform/service-role SDK.
export {
  createAuthoritativeCommandClient,
  createAuthenticatedFetch,
  createCommandScope,
  CommandAuthenticationError,
  type AuthoritativeCommandContract,
  type AuthoritativeCommandOutcome,
  type AuthoritativeCommandTransport,
  type CommandAcknowledgement,
  type CommandDiagnostic,
  type CommandAttempt,
  type CommandScope,
  type SingleAttemptFetch,
} from "@supacloud/contracts/client";
