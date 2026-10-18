import { expect, test } from "bun:test";
import { buildToolDefinitions, type AppManifest } from "./app-tool-export";

test("exported command tools resolve logical and controller-owned Feature routes", () => {
    const manifest: AppManifest = {
        version: 1,
        externalTokens: [],
        modules: [{
            name: "case",
            className: "CaseModule",
            file: "src/case.ts",
            line: 1,
            imports: [],
            providers: [],
            queries: [],
            exports: [],
            commands: [{
                className: "ApproveCaseCommand",
                name: "case.approve",
                permission: "case.approve",
                transaction: "required",
                idempotency: "required",
                audit: "case.approved",
            }],
            featureSpec: {
                name: "case",
                states: ["draft", "approved"],
                transitions: [{
                    name: "approve",
                    from: "draft",
                    to: "approved",
                    command: "case.approve",
                    permission: "case.approve",
                    route: "POST /cases/:id/approve",
                }],
            },
            controllers: [{
                className: "CaseController",
                path: "/cases",
                scope: "application",
                deps: [],
                file: "src/case.controller.ts",
                importPath: "src/case.controller",
                routes: [{
                    method: "POST",
                    path: "/:id/approve",
                    handler: "approve",
                    body: "ApproveCaseBody",
                    params: "ApproveCaseParams",
                    query: "ApproveCaseQuery",
                }],
            }],
        }],
    };

    const definitions = buildToolDefinitions(manifest);
    expect(definitions.openai).toHaveLength(1);
    expect(definitions.openai[0]?.function.description).toContain("HTTP POST /cases/:id/approve");
    expect(definitions.openai[0]?.function.parameters.properties).toEqual(expect.objectContaining({
        body: expect.any(Object),
        params: expect.any(Object),
        query: expect.any(Object),
    }));
    expect(definitions.mcp[0]?.annotations).toEqual(expect.objectContaining({
        permission: "case.approve",
        httpMethod: "POST",
        httpPath: "/cases/:id/approve",
    }));
});
