import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createClient, type RealtimeChannel } from '@supabase/supabase-js'
import { createBackend } from '../src/runtime/index.js'
import { serveBun } from '../src/runtime/node/bun-server.js'

interface Message {
  topic: string
  event: string
  payload: Record<string, unknown>
  ref: string | null
}
type Meta = Record<string, unknown> & { phx_ref: string }
type State = Record<string, { metas: Meta[] }>
type Diff = { joins: State; leaves: State }

let backend: Awaited<ReturnType<typeof createBackend>>
const disconnects: (() => void)[] = []

beforeAll(async () => {
  backend = await createBackend({ startRuntimeServices: false, log: () => {} })
}, 30_000)
afterEach(() => {
  for (const disconnect of disconnects.splice(0)) disconnect()
})
afterAll(async () => { await backend?.close() })

function peer(topic: string, vsn: string) {
  const messages: Message[] = []
  const pending = new Map<string, (message: Message) => void>()
  let counter = 0
  let joinRef: string | null = null
  const connection = backend.realtime.connect({
    send(data) {
      const parsed = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)) as
        Message | [string | null, string | null, string, string, Record<string, unknown>]
      const message = Array.isArray(parsed)
        ? { ref: parsed[1], topic: parsed[2], event: parsed[3], payload: parsed[4] }
        : parsed
      messages.push(message)
      if (message.event === 'phx_reply' && message.ref) pending.get(message.ref)?.(message)
    },
    close() {},
  }, { vsn })
  disconnects.push(connection.onClose)

  async function request(event: string, payload: Record<string, unknown>) {
    const ref = String(++counter)
    if (event === 'phx_join') joinRef = ref
    const response = await new Promise<Message>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(ref)
        reject(new Error(`No reply to ${event}`))
      }, 2000)
      pending.set(ref, (message) => {
        clearTimeout(timeout)
        pending.delete(ref)
        resolve(message)
      })
      connection.onMessage(JSON.stringify(vsn === '2.0.0'
        ? [joinRef, ref, topic, event, payload]
        : { topic, event, payload, ref }))
    })
    expect(response.payload.status).toBe('ok')
  }

  return {
    messages,
    join: (key = 'shared') => request('phx_join', { config: { presence: { key } } }),
    track: (payload: Record<string, unknown>) => request('presence', { event: 'track', payload }),
    untrack: () => request('presence', { event: 'untrack' }),
    leave: () => request('phx_leave', {}),
    close: connection.onClose,
    state: () => messages.findLast((message) => message.event === 'presence_state')?.payload as State,
    diff: () => messages.findLast((message) => message.event === 'presence_diff')?.payload as Diff,
  }
}

for (const vsn of ['1.0.0', '2.0.0']) {
  describe(`Presence session ownership (Phoenix ${vsn})`, () => {
    const fixture = async () => {
      const topic = `realtime:${crypto.randomUUID()}`
      const first = peer(topic, vsn)
      const second = peer(topic, vsn)
      await first.join()
      await second.join()
      const snapshot = async () => {
        const observer = peer(topic, vsn)
        await observer.join('observer')
        const state = observer.state()
        observer.close()
        return state
      }
      return { first, second, snapshot }
    }

    test('aggregates shared-key sessions and ignores client-supplied tracking refs', async () => {
      const { first, second, snapshot } = await fixture()
      await first.track({ tab: 'first' })
      const original = first.diff().joins.shared.metas[0]
      await second.track({ tab: 'second', phx_ref: original.phx_ref, phx_ref_prev: original.phx_ref })
      const added = first.diff().joins.shared.metas[0]
      expect(added.phx_ref).not.toBe(original.phx_ref)
      expect(added).not.toHaveProperty('phx_ref_prev')
      expect(first.diff().leaves).toEqual({})
      expect((await snapshot()).shared.metas).toEqual([original, added])
    })

    test('retracking replaces only the current session metadata', async () => {
      const { first, second, snapshot } = await fixture()
      await first.track({ tab: 'first', status: 'idle' })
      const original = first.diff().joins.shared.metas[0]
      await second.track({ tab: 'second' })
      const other = first.diff().joins.shared.metas[0]
      await first.track({ tab: 'first', status: 'active', phx_ref_prev: other.phx_ref })
      const updated = first.diff().joins.shared.metas[0]
      expect(updated).toMatchObject({ tab: 'first', status: 'active', phx_ref_prev: original.phx_ref })
      expect(updated.phx_ref).not.toBe(original.phx_ref)
      expect(first.diff().leaves).toEqual({ shared: { metas: [original] } })
      expect((await snapshot()).shared.metas).toEqual([other, updated])
    })

    test('untrack removes only owned metadata and is idempotent', async () => {
      const { first, second, snapshot } = await fixture()
      await first.track({ tab: 'first' })
      const original = first.diff().joins.shared.metas[0]
      await second.track({ tab: 'second' })
      const other = first.diff().joins.shared.metas[0]
      await first.untrack()
      expect(second.diff()).toEqual({ joins: {}, leaves: { shared: { metas: [original] } } })
      expect((await snapshot()).shared.metas).toEqual([other])
      const count = second.messages.length
      await first.untrack()
      expect(second.messages).toHaveLength(count)
      await second.untrack()
      expect(await snapshot()).toEqual({})
      await first.track({ tab: 'returned' })
      expect((await snapshot()).shared.metas).toEqual([first.diff().joins.shared.metas[0]])
      first.close()
      expect(await snapshot()).toEqual({})
    })

    test('untracked connections cannot remove another session by untrack or disconnect', async () => {
      const { first, second, snapshot } = await fixture()
      await first.track({ tab: 'first' })
      const original = first.diff().joins.shared.metas[0]
      const count = first.messages.length
      await second.untrack()
      second.close()
      expect(first.messages).toHaveLength(count)
      expect((await snapshot()).shared.metas).toEqual([original])
    })

    for (const action of ['leave', 'close'] as const) {
      test(`${action} removes only the departing session`, async () => {
        const { first, second, snapshot } = await fixture()
        await first.track({ tab: 'first' })
        const original = first.diff().joins.shared.metas[0]
        await second.track({ tab: 'second' })
        const other = first.diff().joins.shared.metas[0]
        await first[action]()
        expect(second.diff()).toEqual({ joins: {}, leaves: { shared: { metas: [original] } } })
        expect((await snapshot()).shared.metas).toEqual([other])
        second.close()
        expect(await snapshot()).toEqual({})
      })
    }

    test('successful rejoin cleans up the previous channel before changing its key', async () => {
      const { first, second, snapshot } = await fixture()
      await first.track({ tab: 'first' })
      const original = first.diff().joins.shared.metas[0]
      await second.track({ tab: 'second' })
      const other = first.diff().joins.shared.metas[0]
      await first.join('new-key')
      expect(second.diff()).toEqual({ joins: {}, leaves: { shared: { metas: [original] } } })
      expect(first.state()).toEqual({ shared: { metas: [other] } })
      await first.track({ tab: 'rejoined' })
      expect(await snapshot()).toEqual({
        shared: { metas: [other] },
        'new-key': { metas: [first.diff().joins['new-key'].metas[0]] },
      })
      first.close()
      expect(await snapshot()).toEqual({ shared: { metas: [other] } })
    })
  })
}

test('Supabase SDK retains sibling sessions through track, untrack and unsubscribe over WebSockets', async () => {
  const server = await serveBun(backend, { port: 0 })
  const clients = Array.from({ length: 2 }, () => createClient(server.url, backend.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  }))
  const topic = crypto.randomUUID()
  const channels = clients.map((client) => client.channel(topic, { config: { presence: { key: 'shared' } } }))
  const [first, second] = channels
  try {
    for (const channel of channels) {
      channel.on('presence', { event: 'sync' }, () => {})
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Presence subscribe timed out')), 3000)
        channel.subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            clearTimeout(timeout)
            resolve()
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            clearTimeout(timeout)
            reject(new Error(status))
          }
        })
      })
    }
    expect(await first.track({ tab: 'first' })).toBe('ok')
    expect(await second.track({ tab: 'second' })).toBe('ok')
    await expectTabs(first, ['first', 'second'])
    await expectTabs(second, ['first', 'second'])
    expect(await first.track({ tab: 'updated' })).toBe('ok')
    await expectTabs(second, ['second', 'updated'])
    expect(await first.untrack()).toBe('ok')
    await expectTabs(second, ['second'])
    expect(await first.track({ tab: 'returned' })).toBe('ok')
    await expectTabs(second, ['returned', 'second'])
    expect(await first.unsubscribe()).toBe('ok')
    await expectTabs(second, ['second'])
  } finally {
    await Promise.all(clients.map((client) => client.removeAllChannels()))
    await server.close()
  }
}, 15_000)

async function expectTabs(channel: RealtimeChannel, tabs: string[]) {
  const current = () => (channel.presenceState<{ tab: string }>().shared ?? []).map((meta) => meta.tab).sort()
  const deadline = Date.now() + 2000
  while (JSON.stringify(current()) !== JSON.stringify(tabs) && Date.now() < deadline) await Bun.sleep(10)
  expect(current()).toEqual(tabs)
}
