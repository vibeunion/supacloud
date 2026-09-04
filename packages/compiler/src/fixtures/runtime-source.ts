/**
 * fixture 项目里 @supacloud/app 的本地替身：同名装饰器与 token 的 noop 实现。
 * AST 分析只按装饰器名匹配，生成代码也不 import 它；实现仅为了让
 * fixture 源码可以被 bun 动态 import 执行。
 */
export const RUNTIME_SOURCE = `export class InjectionToken<T = unknown> {
  readonly name: string;
  readonly scope?: string;

  constructor(name: string, options: { scope?: string } = {}) {
    this.name = name;
    this.scope = options.scope;
  }
}

export function Injectable(_options: { scope?: string; deps?: unknown[] } = {}) {
  return () => {};
}

export function Inject(_token: unknown) {
  return () => {};
}

export function Module(_options: Record<string, unknown>) {
  return () => {};
}

export function defineModule(_options: Record<string, unknown>) {
  return class DefinedModule {};
}

export function Command(_options: Record<string, unknown>) {
  return () => {};
}

export function Query(_options: Record<string, unknown>) {
  return () => {};
}

export function Controller(_path: string) {
  return () => {};
}

function routeDecorator(_method: string) {
  return (_path: string, _options?: Record<string, unknown>) => () => {};
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
