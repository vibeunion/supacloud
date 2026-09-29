/**
 * One editable read resource, not a persistence implementation or a second DI
 * system. Module/provider/controller wiring uses the existing compiler model.
 */
export function resourceScaffold(name: string, className: string): Record<string, string> {
    return {
        [`${name}.model.ts`]: `import { t } from "elysia";

// HTTP contracts are the single source of field types. Services import types only.
export const ${className}Params = t.Object({ id: t.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" }) });
export const ${className}Response = t.Object({ id: t.String() });
export type ${className}Result = typeof ${className}Response.static;
`,
        [`${name}.service.ts`]: `import { Injectable } from "@supacloud/app";
import type { ${className}Result } from "./${name}.model";

@Injectable()
export class ${className}Service {
    find(_id: string): ${className}Result {
        // Supply your project's authorized read port before exposing this route.
        // Writes must use a governed Command; this scaffold never fakes persistence.
        throw new Error("Implement ${className}Service.find before exposing this resource");
    }
}
`,
        [`${name}.controller.ts`]: `import { Controller, Get, Inject, Param } from "@supacloud/app";
import { ${className}Params, ${className}Response, type ${className}Result } from "./${name}.model";
import { ${className}Service } from "./${name}.service";

@Controller("/${name}")
export class ${className}Controller {
    constructor(@Inject(${className}Service) readonly service: ${className}Service) {}

    @Get("/:id", { params: ${className}Params, responses: { 200: ${className}Response } })
    find(@Param("id") id: string): ${className}Result {
        return this.service.find(id);
    }
}
`,
        [`${name}.module.ts`]: `import { Module } from "@supacloud/app";
import { ${className}Controller } from "./${name}.controller";
import { ${className}Service } from "./${name}.service";

@Module({
    name: "${name}",
    tags: ["type:feature"],
    providers: [${className}Service],
    controllers: [${className}Controller],
})
export class ${className}Module {}
`,
        [`${name}.service.test.ts`]: `import { expect, test } from "bun:test";
import { ${className}Service } from "./${name}.service";

test("${name} does not claim a read adapter has been implemented", () => {
    expect(() => new ${className}Service().find("example"))
        .toThrow("Implement ${className}Service.find");
});
`,
        [`${name}.controller.test.ts`]: `import { expect, test } from "bun:test";
import { ${className}Controller } from "./${name}.controller";

test("${name} controller delegates to the supplied read port", () => {
    // Unit-test double only; the generated runtime service remains fail-closed.
    const controller = new ${className}Controller({ find: (id) => ({ id }) });
    expect(controller.find("example")).toEqual({ id: "example" });
});
`,
    };
}
