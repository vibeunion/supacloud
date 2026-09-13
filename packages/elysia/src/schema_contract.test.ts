import { expect, test } from "bun:test";
import { t } from "elysia";
import { createApplication, type CompiledModule } from "./index";
import { createSchemaDecoder, defineJsonContract, SchemaContractError } from "./schema_contract";

const body = t.Object({ name: t.String({ minLength: 1 }) });
const response = t.Object({ version: t.Integer({ minimum: 1 }) });
const contract = defineJsonContract({ body, response }, (input) => ({
  method: "POST", url: "/items", body: input,
}));

test("schema-derived decoders reject malformed values without exposing submitted data", () => {
  expect(contract.body).toBe(body);
  expect(contract.response).toBe(response);
  expect(contract.input({ name: "valid" })).toEqual({ name: "valid" });
  expect(contract.result({ version: 1 })).toEqual({ version: 1 });
  for (const value of [null, {}, { version: "secret" }, { version: 0 }]) {
    expect(() => contract.result(value)).toThrow(SchemaContractError);
  }
  try {
    contract.result({ version: "secret" });
  } catch (error) {
    expect(String(error)).not.toContain("secret");
  }
});

test("the same contract rejects invalid HTTP input before writes and invalid output after one write", async () => {
  let writes = 0;
  const module: CompiledModule = {
    name: "items",
    createServices: () => ({ controller: { save: () => {
      writes++;
      return { version: "invalid" };
    } } }),
    controllers: [{
      path: "/items", serviceKey: "controller", scope: "application",
      routes: [{ method: "POST", path: "", handler: "save", ...contract }],
    }],
  };
  const app = createApplication({ modules: [module] });
  const invalid = await app.handle(new Request("http://localhost/items", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: 1 }),
  }));
  expect(invalid.status).toBe(422);
  expect(writes).toBe(0);
  const result = await app.handle(new Request("http://localhost/items", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "valid" }),
  }));
  expect(result.status).toBe(500);
  expect(writes).toBe(1);
});

test("schema transforms preserve the decoded output type", () => {
  const decode = createSchemaDecoder(t.Transform(t.String()).Decode((value) => value.length).Encode(String));
  const length: number = decode("abc");
  expect(length).toBe(3);
});

// Consumer negative fixtures, checked by typecheck:test.
function schemaTypes() {
  const result: { version: number } = contract.result({ version: 1 });
  const input: { name: string } = contract.input({ name: "valid" });
  // @ts-expect-error Request input is inferred from the schema.
  contract.request({ name: 1 });
  // @ts-expect-error The response type is not chosen by the consumer.
  const wrong: { version: string } = contract.result({});
  // @ts-expect-error A return type cannot be asserted through the schema parameter.
  createSchemaDecoder<{ version: string }>(response);
  return { input, result };
}
