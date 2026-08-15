import { describe, expect, test } from 'bun:test'
import { isGlibcRuntime } from '../src/runtime/node/native/engine.js'

describe('native PostgreSQL platform detection', () => {
  test('accepts independent glibc evidence and rejects musl or unknown runtimes', () => {
    // Cases: runtime report, dynamic loader, ldd fallback, musl, and no evidence.
    expect(isGlibcRuntime({ runtimeVersion: '2.39', dynamicLoaderPresent: false })).toBe(true)
    expect(isGlibcRuntime({ dynamicLoaderPresent: true })).toBe(true)
    expect(isGlibcRuntime({ dynamicLoaderPresent: false, lddVersion: 'ldd (GNU libc) 2.39' })).toBe(true)
    expect(isGlibcRuntime({ dynamicLoaderPresent: false, lddVersion: 'musl libc (x86_64)' })).toBe(false)
    expect(isGlibcRuntime({ dynamicLoaderPresent: false })).toBe(false)
  })
})
