import { expect, test } from 'bun:test'
import { testTimeout } from './helpers/timeouts.js'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type RealtimeChannel } from '@supabase/supabase-js'
import { startProjectServer } from '../src/project-runtime.js'

const chatMigration = `
create table public.messages (
  id text primary key default gen_random_uuid()::text,
  username text not null,
  content text not null,
  room text default 'general',
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table public.messages enable row level security;
create policy messages_anon_select on public.messages for select to anon using (true);
create policy messages_anon_insert on public.messages for insert to anon with check (true);
grant usage on schema public to anon;
grant select, insert on public.messages to anon;
`

test('兼容 Supabase 聊天项目的 messages 迁移、即时读取、Realtime 与 CORS', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-chat-'))
  await mkdir(join(projectDir, 'supabase', 'migrations'), { recursive: true })
  await writeFile(join(projectDir, 'supabase', 'migrations', '20260728000000_create_messages.sql'), chatMigration)

  const running = await startProjectServer({ projectDir, port: 0, log: () => {} })
  const client = createClient(running.url, running.backend.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })

  try {
    const preflight = await fetch(`${running.url}/rest/v1/messages`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:4173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'apikey, authorization, content-type',
      },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST')
    expect(preflight.headers.get('access-control-allow-headers')).toContain('authorization')

    const created = await client.from('messages').insert({ username: 'lite', content: '即时可读' }).select().single()
    expect(created.error).toBeNull()
    expect(created.data).toMatchObject({ username: 'lite', content: '即时可读', room: 'general' })

    const readAfterWrite = await client.from('messages').select('*').eq('id', created.data.id).single()
    expect(readAfterWrite.error).toBeNull()
    expect(readAfterWrite.data).toMatchObject({ id: created.data.id, content: '即时可读' })

    let channel: RealtimeChannel | undefined
    try {
      const received = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('messages realtime event timeout')), 10_000)
        channel = client
          .channel('messages-changes')
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
            clearTimeout(timeout)
            resolve(payload.new as Record<string, unknown>)
          })
          .subscribe(async (status) => {
            if (status === 'SUBSCRIBED') {
              const inserted = await client.from('messages').insert({ username: 'realtime', content: '已推送' })
              if (inserted.error) reject(inserted.error)
            }
            if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
              clearTimeout(timeout)
              reject(new Error(`messages realtime channel status: ${status}`))
            }
          })
      })
      expect(await received).toMatchObject({ username: 'realtime', content: '已推送' })
    } finally {
      if (channel) await client.removeChannel(channel)
    }
  } finally {
    await running.close()
    await rm(projectDir, { recursive: true, force: true })
  }
}, testTimeout(60_000))
