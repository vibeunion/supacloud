/**
 * Pins Lite's function routing rules to the shared parity vectors that the
 * Edge Runtime tests also consume, so the local and production runtimes
 * cannot drift on function-local URL rewriting or router detection.
 */
import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  isFrameworkRouterHandler,
  toFunctionLocalUrl,
  type FrameworkObjectHandler,
} from '../src/runtime/index.js'

interface RouterShape {
  handle?: boolean
  fetch?: boolean
  routes?: boolean
  routeAware?: boolean
}

const vectors = JSON.parse(
  await readFile(join(import.meta.dir, '../parity/function-routing.vectors.json'), 'utf8')
) as {
  urlRewrite: Array<{ input: string; expected: string }>
  routerDetection: Array<{ shape: RouterShape; expected: boolean; note: string }>
}

describe('function routing parity vectors (lite)', () => {
  for (const vector of vectors.urlRewrite) {
    test(`toFunctionLocalUrl ${vector.input}`, () => {
      expect(toFunctionLocalUrl(vector.input)).toBe(vector.expected)
    })
  }

  for (const vector of vectors.routerDetection) {
    test(`isFrameworkRouterHandler: ${vector.note}`, () => {
      const shape: FrameworkObjectHandler = {}
      if (vector.shape.handle) shape.handle = () => new Response()
      if (vector.shape.fetch) shape.fetch = () => new Response()
      if (vector.shape.routes) shape.routes = []
      if (vector.shape.routeAware !== undefined) shape.__supacloud = { routeAware: vector.shape.routeAware }
      expect(isFrameworkRouterHandler(shape)).toBe(vector.expected)
    })
  }
})
