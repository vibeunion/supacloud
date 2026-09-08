import { expect, test } from 'bun:test'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { createSupAuthRequestContext } from '@supacloud/elysia'
import { createSupAuthLiteIdentity } from '../src/runtime/identity.js'
import { createBackend } from '../src/runtime/index.js'
import { signJwt } from '../src/runtime/jwt.js'

const issuer = 'https://identity.example/auth/v1'
const subject = '00000000-0000-0000-0000-000000000001'
async function fixture() {
  const keys = await generateKeyPair('ES256')
  const keyResolver = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'test', alg: 'ES256' }] })
  let permitted = true
  let mapped = true
  const externalIdentity = createSupAuthLiteIdentity({
    projectId: 'application',
    context: createSupAuthRequestContext({
      issuer, audience: 'enterprise', clientId: 'client', projectId: 'application',
      jwksUrl: 'https://identity.example/keys', keyResolver,
      resolveAccess: async () => permitted ? { projectId: 'application', tenantId: 'tenant-a', permissions: ['read'] } : null,
    }),
    resolveLocalSubject: async (identity) => mapped && identity.subject === 'external-person' ? subject : null,
  })
  const token = (claims: Record<string, unknown> = {}) => new SignJWT({
    sub: 'external-person', iss: issuer, aud: 'enterprise', role: 'authenticated', client_id: 'client',
    exp: Math.floor(Date.now() / 1000) + 120, iat: Math.floor(Date.now() / 1000), ...claims,
  }).setProtectedHeader({ alg: 'ES256', kid: 'test' }).sign(keys.privateKey)
  return { externalIdentity, token, revoke: () => { permitted = false }, unmap: () => { mapped = false } }
}

test('real asymmetric SupAuth verification maps only trusted local RLS claims', async () => {
  const identity = await fixture()
  const backend = await createBackend({
    externalIdentity: identity.externalIdentity, startRuntimeServices: false,
    migrations: [{ name: '100_identity', sql: `
      create table public.private_items(id int, user_id uuid, tenant_id text);
      alter table public.private_items enable row level security;
      create policy read_own on public.private_items for select to authenticated
        using (user_id = auth.uid() and tenant_id = auth.jwt()->>'tenant_id');
      grant select on public.private_items to authenticated;
      insert into public.private_items values (1, '${subject}', 'tenant-a'), (2, '${subject}', 'tenant-b');
      create function public.identity_subject() returns uuid language sql stable as $$ select auth.uid() $$;
      grant execute on function public.identity_subject() to authenticated;
    ` }],
    functions: { who: (_request, context) => Response.json(context.auth.claims) },
  })
  const request = (path: string, token: string) => backend.fetch(`http://local${path}`, {
    headers: { authorization: `Bearer ${token}`, 'x-tenant-id': 'tenant-b', 'x-supacloud-jwt-sub': 'forged' },
  })
  try {
    const token = await identity.token({ tenant_id: 'tenant-b', permissions: ['admin'] })
    expect(await (await request('/rest/v1/private_items?select=id', token)).json()).toEqual([{ id: 1 }])
    expect(await (await request('/rest/v1/rpc/identity_subject', token)).json()).toBe(subject)
    const claims = await (await request('/functions/v1/who', token)).json()
    expect(claims).toMatchObject({ sub: subject, external_sub: 'external-person', tenant_id: 'tenant-a', permissions: ['read'], role: 'authenticated' })
    expect((await request('/auth/v1/user', token)).status).toBe(404)
    for (const invalid of [
      await identity.token({ iss: 'https://wrong.example' }), await identity.token({ aud: 'wrong' }),
      await identity.token({ client_id: 'other' }), await identity.token({ role: 'service_role' }),
      await identity.token({ exp: 1 }), token + 'x',
      await signJwt({ role: 'authenticated', sub: subject, exp: Math.floor(Date.now() / 1000) + 60 }, backend.jwtSecret),
    ]) expect((await request('/rest/v1/private_items', invalid)).status).toBe(401)
    expect((await request('/functions/v1/who', backend.serviceRoleKey)).status).toBe(200)
    identity.revoke()
    expect((await request('/rest/v1/private_items', token)).status).toBe(403)
  } finally { await backend.close() }
})

test('unmapped identity and verification outage fail closed without leaking errors', async () => {
  const identity = await fixture()
  identity.unmap()
  const backend = await createBackend({ externalIdentity: identity.externalIdentity, startRuntimeServices: false })
  try {
    const denied = await backend.fetch('http://local/rest/v1/items', { headers: { authorization: `Bearer ${await identity.token()}` } })
    expect(denied.status).toBe(403)
  } finally { await backend.close() }
  const unavailable = await createBackend({ externalIdentity: async () => { throw new Error('private-secret-endpoint') }, startRuntimeServices: false })
  try {
    const response = await unavailable.fetch('http://local/rest/v1/items', { headers: { authorization: 'Bearer opaque' } })
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('private-secret-endpoint')
  } finally { await unavailable.close() }
})

test('Realtime rejects invalid external tokens and removes channels after a failed refresh', async () => {
  const identity = await fixture()
  const backend = await createBackend({ externalIdentity: identity.externalIdentity, startRuntimeServices: false })
  const messages: any[] = []
  let notify: (() => void) | undefined
  const connection = backend.realtime.connect({
    send: (text) => { messages.push(JSON.parse(text as string)); notify?.() },
    close: () => {},
  })
  const exchange = async (message: unknown) => {
    const start = messages.length
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Realtime fixture reply timed out')), 2000)
      notify = () => {
        if (messages.slice(start).some((value) => value.event === 'phx_reply')) {
          clearTimeout(timeout); notify = undefined; resolve()
        }
      }
      connection.onMessage(JSON.stringify(message))
    })
    return messages.slice(start).find((value) => value.event === 'phx_reply')
  }
  try {
    const join = (token: string, ref: string) => ({ topic: 'realtime:room', event: 'phx_join', ref, payload: { access_token: token } })
    expect((await exchange(join('invalid', '1'))).payload.status).toBe('error')
    expect((await exchange(join(await identity.token(), '2'))).payload.status).toBe('ok')
    const refresh = await exchange({ topic: 'realtime:room', event: 'access_token', ref: '3', payload: { access_token: 'invalid' } })
    expect(refresh.payload.status).toBe('error')
    const connections = (backend.realtime as unknown as { connections: Set<{ channels: Map<string, unknown> }> }).connections
    expect([...connections][0]!.channels.size).toBe(0)
  } finally { connection.onClose(); await backend.close() }
})
