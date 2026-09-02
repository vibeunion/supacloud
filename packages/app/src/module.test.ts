import { describe, expect, test } from "bun:test";
import { getModuleMeta, Injectable, Module } from "./decorators";
import { defineModule } from "./module";

describe("defineModule", () => {
  test("produces metadata identical to @Module", () => {
    @Injectable()
    class CaseService {}

    @Module({ name: "case", providers: [CaseService], exports: [CaseService] })
    class DecoratedModule {}

    const DefinedModule = defineModule({
      name: "case",
      providers: [CaseService],
      exports: [CaseService],
    });

    expect(getModuleMeta(DefinedModule)).toEqual(getModuleMeta(DecoratedModule));
    expect(DefinedModule.name).toBe("case");
  });
});
