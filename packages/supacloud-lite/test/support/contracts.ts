import assert from 'node:assert/strict'
import { isRecord } from '../../src/runtime/validation.js'

export function record(value: unknown): Record<string, unknown> {
  assert(isRecord(value), 'expected a JSON object')
  return value
}

export function array(value: unknown): unknown[] {
  assert(Array.isArray(value), 'expected a JSON array')
  return value
}

export async function readJson(response: Response): Promise<unknown> {
  return response.json()
}

// Generated files do not exist at typecheck time. Keep their dynamic exports
// unknown and validate each result in the caller.
export async function callExport(url: string, name: string, argument: unknown): Promise<unknown> {
  const module: unknown = await import(url)
  return callMethod(record(module), name, argument)
}

export async function callMethod(object: Record<string, unknown>, name: string, argument: unknown): Promise<unknown> {
  const method = object[name]
  assert(typeof method === 'function', `missing callable export: ${name}`)
  const result: unknown = await method.call(object, argument)
  return result
}

export function orderNodes(data: unknown): Array<{ id: number; customer: { name: string } | null }> {
  return array(record(record(data)['ordersCollection'])['edges']).map((edge) => {
    const node = record(record(edge)['node'])
    const id = node['id']
    assert(typeof id === 'number' && Number.isSafeInteger(id), 'invalid order id')
    const customer = node['customer']
    if (customer === null) return { id, customer: null }
    const name = record(customer)['name']
    assert(typeof name === 'string', 'invalid customer name')
    return { id, customer: { name } }
  })
}
