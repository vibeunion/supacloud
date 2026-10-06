import { Type } from "typebox";
import { Value } from "typebox/value";
import { defineResource, parseContractCreateInput, parseContractRecord } from "@svadmin/core/resource-contract";
import { apiClient, ensureMutationSucceeded, type ApiRequestInit } from "./api";
import { requestValidatedJson } from "./validated-json";
import { canonicalizeAuthUrlConfig } from "./generated/auth-url-validation";
import {
  authUrlConfigInputSchema, authUrlConfigRecordSchema,
  type AuthUrlConfigInput,
} from "./generated/auth-url-config";

const authUrlConfigContract = defineResource("/v1/projects/:ref/auth/config", {
  // This id represents the singleton form only; it is never sent to the API.
  record: Type.Object({
    id: Type.Literal("auth-url-config"),
    site_url: Type.String(),
    uri_allow_list: Type.String(),
  }, { additionalProperties: false }),
  create: authUrlConfigInputSchema,
});
export type { AuthUrlConfigInput } from "./generated/auth-url-config";

function projectPath(projectRef: string): string {
  if (!projectRef || !/^[A-Za-z0-9_-]+$/.test(projectRef)) throw new Error("Invalid project reference");
  return `/v1/projects/${encodeURIComponent(projectRef)}/auth/config`;
}

function validateInput(input: AuthUrlConfigInput): AuthUrlConfigInput {
  const snapshot = parseContractCreateInput(authUrlConfigContract, input);
  return parseContractCreateInput(authUrlConfigContract, canonicalizeAuthUrlConfig(snapshot));
}

function readUrlConfig(value: unknown, receipt = false): { siteUrl: string; redirectUrls: string[] } {
  if (!Value.Check(authUrlConfigRecordSchema, value)) throw new Error("Invalid auth URL configuration");
  if (receipt && (value.site_url === undefined || value.uri_allow_list === undefined)) {
    throw new Error("Missing canonical auth URL receipt");
  }
  if ((value.site_url !== undefined && value.SITE_URL !== undefined && value.site_url !== value.SITE_URL)
    || (value.uri_allow_list !== undefined && value.URI_ALLOW_LIST !== undefined
      && value.uri_allow_list !== value.URI_ALLOW_LIST)) {
    throw new Error("Conflicting auth URL configuration aliases");
  }
  const record = parseContractRecord(authUrlConfigContract, {
    id: "auth-url-config",
    site_url: value.site_url ?? value.SITE_URL ?? "",
    uri_allow_list: value.uri_allow_list ?? value.URI_ALLOW_LIST ?? value.REDIRECT_URLS ?? "",
  });
  return {
    siteUrl: record.site_url,
    redirectUrls: record.uri_allow_list.split(",").map(value => value.trim()).filter(Boolean),
  };
}

export function createAuthUrlConfigClient(
  projectRef: string,
  request: (url: string, options?: ApiRequestInit) => Promise<Response> = apiClient,
) {
  const path = projectPath(projectRef);
  return {
    async read(signal?: AbortSignal) {
      return requestValidatedJson(path, request, value => readUrlConfig(value), { signal });
    },
    async update(input: AuthUrlConfigInput, signal?: AbortSignal) {
      signal?.throwIfAborted();
      const submitted = validateInput(input);
      const response = await request(path, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(submitted),
        signal,
      });
      let received: { siteUrl: string; redirectUrls: string[] } | undefined;
      await ensureMutationSucceeded(response, "保存认证 URL 配置失败", value => {
        received = readUrlConfig(value, true);
        if (!Value.Check(authUrlConfigRecordSchema, value)
          || value.site_url !== submitted.site_url
          || value.uri_allow_list !== submitted.uri_allow_list) {
          throw new Error("Authentication URL configuration response does not match the request");
        }
      }, { signal });
      if (!received
        || received.siteUrl !== submitted.site_url
        || received.redirectUrls.join(",") !== submitted.uri_allow_list) {
        throw new Error("Authentication URL configuration response does not match the request");
      }
      return received;
    },
  };
}
