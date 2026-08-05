import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { startProjectServer, type RunningProjectServer } from '../src/project-runtime.js'

/**
 * A fresh Lite project that declares a bucket in config.toml but ships no
 * storage.objects RLS policy must reject uploads with an actionable 403 that
 * points the developer at the missing policy — not a bare Postgres
 * "row-level security" message. Official Supabase leaves storage.objects
 * locked down by default; Lite matches that, but surfaces a clearer hint.
 */
describe('Storage default RLS error message (no user-authored objects policy)', () => {
  let rootDir: string
  let project: RunningProjectServer
  let anonClient: SupabaseClient
  let userAccessToken: string

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-storage-rls-msg-'))
    await mkdir(join(rootDir, 'supabase', 'migrations'), { recursive: true })
    await writeFile(
      join(rootDir, 'supabase', 'migrations', '0001_notes.sql'),
      'create table public.notes (id int primary key, body text);\nalter table public.notes enable row level security;\ncreate policy notes_read on public.notes for select using (true);\n',
    )
    await writeFile(
      join(rootDir, 'supabase', 'config.toml'),
      '[auth.email]\nenable_confirmations = false\n\n[storage]\nfile_size_limit = "1MiB"\n\n[storage.buckets.images]\npublic = true\nallowed_mime_types = ["text/plain"]\n',
    )
    project = await startProjectServer({ projectDir: rootDir, port: 0, log: () => {} })
    const opts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
    anonClient = createClient(project.url, project.backend.anonKey, opts)
    const signUpClient = createClient(project.url, project.backend.anonKey, opts)
    const { data, error } = await signUpClient.auth.signUp({ email: 'rls-msg@example.com', password: 'correct-horse-battery-staple' })
    expect(error).toBeNull()
    userAccessToken = data.session!.access_token
  }, 60_000)

  afterAll(async () => {
    await project?.close()
    if (rootDir) await rm(rootDir, { recursive: true, force: true })
  })

  test('authenticated upload is denied with an actionable policy hint', async () => {
    const userClient = createClient(project.url, project.backend.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { Authorization: `Bearer ${userAccessToken}` } },
    })
    const upload = await userClient.storage.from('images').upload('no-policy.txt', new TextEncoder().encode('blocked'), { contentType: 'text/plain' })
    expect(upload.error).not.toBeNull()
    expect(upload.error!.statusCode).toBe('403')
    // The hint must point at the missing storage.objects policy and must not
    // be the bare Postgres message that gave no guidance.
    expect(upload.error!.message).toContain('storage.objects RLS')
    expect(upload.error!.message).toContain('create policy')
    expect(upload.error!.message).not.toContain('new row violates row-level security policy')
  })

  test('anonymous upload is also denied with the same hint', async () => {
    const upload = await anonClient.storage.from('images').upload('anon.txt', new TextEncoder().encode('x'), { contentType: 'text/plain' })
    expect(upload.error).not.toBeNull()
    expect(upload.error!.statusCode).toBe('403')
    expect(upload.error!.message).toContain('storage.objects RLS')
  })
})
