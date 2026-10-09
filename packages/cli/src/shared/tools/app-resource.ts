/**
 * One editable read resource, not a persistence implementation or a second DI
 * system. Module/provider/controller wiring uses the existing compiler model.
 */
export function resourceScaffold(name: string, className: string): Record<string, string> {
    return {
        [`${name}.model.ts`]: `import { t } from "elysia";
import { InjectionToken, type RouteHandlerOutput } from "@supacloud/app";

// HTTP contracts are the single source of field types. Services import types only.
export const ${className}Params = t.Object({ id: t.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" }) });
export const ${className}Response = t.Object({ id: t.String() });
export type ${className}Result = RouteHandlerOutput<{ responses: { 200: typeof ${className}Response } }>;

// Bind a request-scoped adapter using the verified user and RLS. It must reject
// denied/not-found reads; never bind a browser-supplied identity or service-role fallback.
export interface ${className}ReadPort {
    readAuthorized(id: string): Promise<${className}Result>;
}
export const ${className}Reader = new InjectionToken<${className}ReadPort>("${name}.reader", { scope: "request" });
`,
        [`${name}.service.ts`]: `import { Inject, Injectable, Optional } from "@supacloud/app";
import { ${className}Reader, type ${className}ReadPort, type ${className}Result } from "./${name}.model";

@Injectable({ scope: "request" })
export class ${className}Service {
    constructor(@Inject(${className}Reader) @Optional() readonly reader?: ${className}ReadPort) {}

    async find(id: string): Promise<${className}Result> {
        if (!this.reader) throw new Error("Bind ${className}Reader before exposing this resource");
        return this.reader.readAuthorized(id);
    }
}
`,
        [`${name}.controller.ts`]: `import * as Effect from "effect/Effect";
import { Controller, Get, Inject, Param } from "@supacloud/app";
import { ${className}Params, ${className}Response, type ${className}Result } from "./${name}.model";
import { ${className}Service } from "./${name}.service";

@Controller("/${name}")
export class ${className}Controller {
    constructor(@Inject(${className}Service) readonly service: Pick<${className}Service, "find">) {}

    @Get("/:id", {
        params: ${className}Params,
        responses: { 200: ${className}Response },
        effect: { required: true, dependencies: [], errors: [], retry: "none" },
    })
    find(@Param("id") id: string): Effect.Effect<${className}Result, never, never> {
        return Effect.promise(() => this.service.find(id));
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

test("${name} does not claim a read adapter has been implemented", async () => {
    await expect(new ${className}Service().find("example"))
        .rejects.toThrow("Bind ${className}Reader");
});

test("${name} returns only the supplied authorized read result", async () => {
    const service = new ${className}Service({ readAuthorized: async id => ({ id }) });
    expect(await service.find("example")).toEqual({ id: "example" });
});

test("${name} preserves permission denial without a privileged fallback", async () => {
    const denied = new Error("denied");
    const service = new ${className}Service({ readAuthorized: async () => { throw denied; } });
    await expect(service.find("example")).rejects.toBe(denied);
});
`,
        [`${name}.controller.test.ts`]: `import * as Effect from "effect/Effect";
import { expect, test } from "bun:test";
import { ${className}Controller } from "./${name}.controller";

test("${name} controller delegates to the supplied asynchronous read port", async () => {
    // Unit-test double only; the generated runtime service remains fail-closed.
    const controller = new ${className}Controller({ find: async (id) => ({ id }) });
    expect(await Effect.runPromise(controller.find("example"))).toEqual({ id: "example" });
});

test("${name} controller preserves an asynchronous read failure", async () => {
    const failure = new Error("read port unavailable");
    const controller = new ${className}Controller({ find: async () => { throw failure; } });
    await expect(Effect.runPromise(controller.find("example"))).rejects.toThrow("read port unavailable");
});
`,
    };
}
