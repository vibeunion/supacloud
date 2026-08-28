import { describe, expect, it } from "bun:test";
import { normalizeRpcSchemas } from "../../src/services/database-governance-input";
import {
  parseSmartTags,
  inferRpcKind,
  readRpcCatalog,
} from "../../src/services/database-rpc-catalog.service";

describe("normalizeRpcSchemas", () => {
  it("defaults, trims, and de-duplicates schemas", () => {
    expect(normalizeRpcSchemas([" public ", "api", "public"])).toEqual(["public", "api"]);
    expect(normalizeRpcSchemas(undefined)).toEqual(["public", "api"]);
  });

  it("rejects unsafe or excessive schema selectors", () => {
    expect(() => normalizeRpcSchemas(["public;drop schema x"])).toThrow();
    expect(() => normalizeRpcSchemas(Array.from({ length: 17 }, (_, i) => `s${i}`))).toThrow();
  });
});

describe("parseSmartTags", () => {
  it("parses tags from SQL comment", () => {
    const comment = `
@api command
@domain case_approval
@owner fa_team
@idempotency command_id
@auth authenticated
@strict
`;
    const tags = parseSmartTags(comment);
    expect(tags.api).toBe("command");
    expect(tags.domain).toBe("case_approval");
    expect(tags.owner).toBe("fa_team");
    expect(tags.idempotency).toBe("command_id");
    expect(tags.auth).toBe("authenticated");
    expect(tags.strict).toBe(true);
  });

  it("returns empty object on null or empty comment", () => {
    expect(parseSmartTags(null)).toEqual({});
    expect(parseSmartTags("")).toEqual({});
  });

  it("ignores at-signs embedded in ordinary comment text", () => {
    expect(parseSmartTags("Owner: dev@example.com\nThis is not @api metadata")).toEqual({});
  });
});

describe("inferRpcKind", () => {
  it("respects explicit @api smart tags", () => {
    expect(inferRpcKind("some_func", "VOLATILE", "void", { api: "query" })).toBe("query");
    expect(inferRpcKind("get_data", "STABLE", "json", { api: "command" })).toBe("command");
    expect(inferRpcKind("internal_calc", "VOLATILE", "void", { api: "internal" })).toBe("internal");
  });

  it("infers command from naming prefixes", () => {
    expect(inferRpcKind("approve_case", "VOLATILE", "json", {})).toBe("command");
    expect(inferRpcKind("create_order", "VOLATILE", "uuid", {})).toBe("command");
    expect(inferRpcKind("delete_record", "VOLATILE", "void", {})).toBe("command");
  });

  it("infers query from naming prefixes and STABLE/IMMUTABLE volatility", () => {
    expect(inferRpcKind("get_case_summary", "VOLATILE", "json", {})).toBe("query");
    expect(inferRpcKind("calculate_tax", "IMMUTABLE", "numeric", {})).toBe("query");
    expect(inferRpcKind("custom_search", "STABLE", "setof cases", {})).toBe("query");
  });
});

describe("readRpcCatalog", () => {
  it("maps postgres catalog rows to typed RpcCatalogEntry items", async () => {
    let catalogQuery = "";
    const mockDb = {
      unsafe: async (sqlText: string) => {
        catalogQuery = sqlText;
        return [
        {
          schema_name: "public",
          function_name: "approve_case",
          identity_args: "p_case_id uuid, p_user_id uuid",
          arguments_display: "p_case_id uuid, p_user_id uuid",
          return_type: "json",
          language: "plpgsql",
          volatility_char: "v",
          security_definer: true,
          is_strict: true,
          config: ["search_path=pg_catalog, public"],
          comment: "@api command\n@domain approval",
        },
        {
          schema_name: "public",
          function_name: "get_case_details",
          identity_args: "p_case_id uuid",
          arguments_display: "p_case_id uuid",
          return_type: "jsonb",
          language: "sql",
          volatility_char: "s",
          security_definer: false,
          is_strict: false,
          config: null,
          comment: null,
        },
        ];
      },
    };

    const catalog = await readRpcCatalog(mockDb as any, ["public"]);
    expect(catalog.length).toBe(2);

    const approve = catalog[0]!;
    expect(approve.function_name).toBe("approve_case");
    expect(approve.security).toBe("DEFINER");
    expect(approve.search_path).toBe("pg_catalog, public");
    expect(approve.inferred_kind).toBe("command");
    expect(approve.smart_tags.domain).toBe("approval");

    const getDetails = catalog[1]!;
    expect(getDetails.function_name).toBe("get_case_details");
    expect(getDetails.security).toBe("INVOKER");
    expect(getDetails.search_path).toBeNull();
    expect(getDetails.inferred_kind).toBe("query");
    expect(catalogQuery).toContain("p.prokind = 'f'");
  });
});
