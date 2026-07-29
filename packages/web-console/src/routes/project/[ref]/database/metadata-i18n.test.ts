import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const schemasSource = readFileSync(new URL("./schemas/+page.svelte", import.meta.url), "utf8");
const enumTypesSource = readFileSync(new URL("./types/+page.svelte", import.meta.url), "utf8");
const functionsSource = readFileSync(new URL("./functions/+page.svelte", import.meta.url), "utf8");
const triggersSource = readFileSync(new URL("./triggers/+page.svelte", import.meta.url), "utf8");

describe("database metadata i18n", () => {
  test("describes common schemas without replacing their technical names or owners", () => {
    expect(schemasSource).toContain('auth: "Schemas.auth_description"');
    expect(schemasSource).toContain('storage: "Schemas.storage_description"');
    expect(schemasSource).toContain('extensions: "Schemas.extensions_description"');
    expect(schemasSource).toContain("schemaDescription(schema.schema_name)");
    expect(schemasSource).toContain("{schema.schema_name}");
    expect(schemasSource).toContain("{schema.schema_owner}");
  });

  test("filters enum types by search text and raw schema while retaining enum values", () => {
    expect(enumTypesSource).toContain("let schemaFilter = $state(\"all\")");
    expect(enumTypesSource).toContain("const filteredTypes = $derived");
    expect(enumTypesSource).toContain('<select bind:value={schemaFilter}');
    expect(enumTypesSource).toContain("{#each filteredTypes as typ}");
    expect(enumTypesSource).toContain('title={val}');
    expect(enumTypesSource).toContain('$t("EnumTypes.values_hint")');
  });

  test("keeps functions read-only while localizing known metadata labels", () => {
    expect(functionsSource).toContain("let schemaFilter = $state(\"public\")");
    expect(functionsSource).toContain("functionLanguageLabel(fn.language)");
    expect(functionsSource).toContain("functionVolatilityLabel(fn.volatility)");
    expect(functionsSource).toContain("postgresTypeLabel(fn.return_type)");
    expect(functionsSource).toContain("title={fn.return_type}");
    expect(functionsSource).toContain("{fn.arguments || \"()\"}");
    expect(functionsSource).not.toMatch(/CREATE\s+FUNCTION|DROP\s+FUNCTION|mode:\s*\"migration\"/);
  });

  test("localizes trigger metadata without adding trigger DDL controls", () => {
    expect(triggersSource).toContain('$t("Triggers.status")');
    expect(triggersSource).toContain("triggerEventLabel(trg.event_manipulation)");
    expect(triggersSource).toContain("triggerTimingLabel(trg.action_timing)");
    expect(triggersSource).toContain("{trg.event_object_table}");
    expect(triggersSource).toContain("{extractFuncName(trg.action_statement)}");
    expect(triggersSource).not.toMatch(/CREATE\s+TRIGGER|DROP\s+TRIGGER|mode:\s*\"migration\"/);
  });
});
