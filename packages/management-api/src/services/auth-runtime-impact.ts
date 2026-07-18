import { isDeepStrictEqual } from "node:util";
import {
  normalizeOAuthServerConfig,
  normalizeThirdPartyAuthConfig,
} from "../utils/project-config";

function postgrestVerifierProjection(authConfig: Record<string, unknown>) {
  const oauthServer = normalizeOAuthServerConfig(authConfig.oauth_server);
  const thirdPartyAuth = normalizeThirdPartyAuthConfig(authConfig.third_party_auth);

  return {
    oauth_server: {
      enabled: oauthServer.enabled === true,
      issuer: oauthServer.issuer ?? null,
      signing_alg: oauthServer.signing_alg ?? null,
      jwt_keys: oauthServer.jwt_keys ?? null,
      jwt_jwks: oauthServer.jwt_jwks ?? null,
    },
    third_party_auth: {
      enabled: thirdPartyAuth.enabled,
      issuer: thirdPartyAuth.issuer ?? null,
      audience: thirdPartyAuth.audience ?? null,
      client_id: thirdPartyAuth.client_id ?? null,
      jwt_jwks: thirdPartyAuth.jwt_jwks ?? null,
    },
  };
}

export function authConfigChangesPostgrestVerifier(
  previousAuth: Record<string, unknown>,
  nextAuth: Record<string, unknown>,
): boolean {
  return !isDeepStrictEqual(
    postgrestVerifierProjection(previousAuth),
    postgrestVerifierProjection(nextAuth),
  );
}
