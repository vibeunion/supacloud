declare module "bun:test" {
  export function describe(name: string, fn: () => void): void;
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;

  export interface MockMetadata<TArgs extends unknown[] = unknown[]> {
    calls: TArgs[];
  }

  export interface Mock<TArgs extends unknown[] = unknown[], TResult = unknown> {
    (...args: TArgs): TResult;
    mock: MockMetadata<TArgs>;
    mockResolvedValue(value: Awaited<TResult>): Mock<TArgs, TResult>;
    mockResolvedValueOnce(value: Awaited<TResult>): Mock<TArgs, TResult>;
    mockImplementation(impl: (...args: TArgs) => TResult): Mock<TArgs, TResult>;
    mockRestore(): void;
  }

  export const mock: {
    <TArgs extends unknown[] = unknown[], TResult = unknown>(
      impl?: (...args: TArgs) => TResult,
    ): Mock<TArgs, TResult>;
    restore(): void;
  };

  export function spyOn<T extends object, K extends keyof T>(
    object: T,
    key: K,
  ): T[K] extends (...args: infer TArgs) => infer TResult
    ? Mock<TArgs, TResult>
    : never;

  export interface Expectation {
    toBe(expected: unknown): void;
    toContain(expected: unknown): void;
    toEqual(expected: unknown): void;
    toMatchObject(expected: unknown): void;
    toHaveProperty(property: string): void;
    toHaveBeenCalledTimes(expected: number): void;
    toHaveBeenCalled(): void;
    toBeInstanceOf(expected: unknown): void;
    toBeGreaterThanOrEqual(expected: number): void;
    toThrow(expected?: unknown): void;
    not: Expectation;
    rejects: {
      toBeInstanceOf(expected: unknown): Promise<void>;
    };

  }

  export function expect(value: unknown): Expectation;
}
