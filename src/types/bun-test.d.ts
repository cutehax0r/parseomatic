// Minimal ambient types for `bun:test`, covering only what this project's
// *.test.ts files actually use. Bun's runtime resolves `bun:test`
// intrinsically (no install needed to run `bun test`); this file exists
// only so `tsc --noEmit` (part of `bun run build`) type-checks test files
// without depending on the full `@types/bun` package.

declare module "bun:test" {
  export function describe(name: string, fn: () => void): void;
  export function test(name: string, fn: () => void | Promise<void>): void;

  export interface Matchers<T> {
    toBe(expected: T): void;
    toBeNull(): void;
    toBeTruthy(): void;
    toEqual(expected: unknown): void;
    toHaveLength(expected: number): void;
    toBeGreaterThan(expected: number): void;
    toContain(expected: unknown): void;
    not: Matchers<T>;
  }

  export function expect<T>(actual: T): Matchers<T>;
}
