export interface MockModuleNode {
  name: string;
  className: string;
  tags?: string[];
  file: string;
  line: number;
  imports: string[];
  providers: any[];
  controllers: any[];
  commands: any[];
  queries: any[];
  exports: string[];
  [key: string]: unknown;
}

export interface MockRouteNode {
  method: string;
  path: string;
  handler: string;
  body?: unknown;
  params?: unknown;
  query?: unknown;
  response?: unknown;
  command?: string;
  [key: string]: unknown;
}

export interface MockControllerNode {
  className: string;
  path: string;
  scope: string;
  deps: string[];
  routes: MockRouteNode[];
  file: string;
  importPath: string;
  [key: string]: unknown;
}

export interface MockCommandNode {
  className: string;
  name: string;
  permission?: string;
  transaction?: "required" | "none" | string;
  audit?: string;
  idempotency?: "required" | "none" | string;
  [key: string]: unknown;
}

export interface MockApplicationGraph {
  modules: MockModuleNode[];
  externalTokens: string[];
  [key: string]: unknown;
}

export function createMockModule(overrides: Partial<MockModuleNode> = {}): MockModuleNode {
  return {
    name: "test-module",
    className: "TestModule",
    file: "src/test.module.ts",
    line: 1,
    imports: [],
    providers: [],
    controllers: [],
    commands: [],
    queries: [],
    exports: [],
    ...overrides,
  };
}

export function createMockController(
  path: string,
  routes: MockRouteNode[] = [],
  overrides: Partial<MockControllerNode> = {},
): MockControllerNode {
  return {
    className: "TestController",
    path,
    scope: "request",
    deps: [],
    routes,
    file: "src/test.controller.ts",
    importPath: "./test.controller",
    ...overrides,
  };
}

export function createMockCommand(
  name: string,
  overrides: Partial<MockCommandNode> = {},
): MockCommandNode {
  const cleanName = name.replace(/[^a-zA-Z0-9]/g, "");
  const capitalized = cleanName.charAt(0).toUpperCase() + cleanName.slice(1);
  return {
    className: `${capitalized}Command`,
    name,
    permission: "test:execute",
    transaction: "none",
    idempotency: "none",
    ...overrides,
  };
}

export function createMockGraph(
  modules: MockModuleNode[] = [],
  externalTokens: string[] = [],
): MockApplicationGraph {
  return { modules, externalTokens };
}
