/**
 * Local stand-in for @supacloud/app in fixture projects: noop implementations of decorators and tokens.
 * AST analysis matches decorators by name only and generated code does not import it;
 * implementation lets fixture sources pass TypeScript checks and execute under bun.
 */
export const RUNTIME_SOURCE = `export class InjectionToken<T = unknown> {
  readonly name: string;
  readonly scope: string | undefined;

  constructor(name: string, options: { scope?: string } = {}) {
    this.name = name;
    this.scope = options.scope;
  }
}

export function Injectable(_options: { scope?: string; deps?: unknown[] } = {}) {
  return (..._args: unknown[]) => {};
}

export function Inject(_token: unknown) {
  return (..._args: unknown[]) => {};
}

export function Module(_options: Record<string, unknown>) {
  return (..._args: unknown[]) => {};
}

export function defineModule(_options: Record<string, unknown>) {
  return class DefinedModule {};
}

export function Command(_options: Record<string, unknown>) {
  return (..._args: unknown[]) => {};
}

export function Job(_options: Record<string, unknown>) {
  return (..._args: unknown[]) => {};
}

export function Query(_options: Record<string, unknown>) {
  return (..._args: unknown[]) => {};
}

export function InfraResource(_options: { name: string; kind: string }) {
  return (..._args: unknown[]) => {};
}

export function Controller(_path: string) {
  return (..._args: unknown[]) => {};
}

function routeDecorator(_method: string) {
  return (_path: string, _options?: Record<string, unknown>) => (..._args: unknown[]) => {};
}

export const Get = routeDecorator("GET");
export const Post = routeDecorator("POST");
export const Put = routeDecorator("PUT");
export const Patch = routeDecorator("PATCH");
export const Delete = routeDecorator("DELETE");
export const Head = routeDecorator("HEAD");
export const Options = routeDecorator("OPTIONS");

export const REQUEST_CONTEXT = new InjectionToken("supacloud.request-context", {
  scope: "request",
});
export const JOB_CONTEXT = new InjectionToken("supacloud.job-context", {
  scope: "job",
});
`;

export const FIXTURE_TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "experimentalDecorators": true,
    "strict": true
  }
}
`;
