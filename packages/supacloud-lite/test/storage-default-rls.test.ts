import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { startProjectServer, type RunningProjectServer } from '../src/project-runtime.js'

/**
 * Regression: a fresh Lite project that declares a *public* bucket in
 * config.toml but ships no user-authored storage.objects RLS policy must
 * still allow uploads. Previously bootstrap dropped the legacy default
 * storage policies and never recreated them, so RLS was enabled with no
 * policy and every upload returned 403.
 *
 * This project intentionally omits any `create policy ... on storage.objects`
 * from its migrations to prove the bootstrap's own defaults are sufficient.
 */
describe('Storage default RLS (no user-authored objects policy)', () => {
  let rootDir: string
  let project: RunningProjectServer
  let anonClient: SupabaseClient
  let userAccessToken: string

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-default-rls-'))
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
    // dedicated client for signup so anonClient stays session-less
    const signUpClient = createClient(project.url, project.backend.anonKey, opts)
    const { data, error } = await signUpClient.auth.signUp({ email: 'default-rls@example.com', password: 'correct-horse-battery-staple' })
    expect(error).toBeNull()
    userAccessToken = data.session!.access_token
  }, 60_000)

  afterAll(async () => {
    await project?.close()
    if (rootDir) await rm(rootDir, { recursive: true, force: true })
  })

  test('authenticated upload to a config-declared public bucket succeeds', async () => {
    const userClient = createClient(project.url, project.backend.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { Authorization: `Bearer ${userAccessToken}` } },
    })
    const upload = await userClient.storage.from('images').upload('ok.txt', new TextEncoder().encode('default rls ok'), { contentType: 'text/plain' })
    expect(upload.error).toBeNull()
  })

  test('anonymous public read returns the uploaded object', async () => {
    const res = await fetch(`${project.url}/storage/v1/object/public/images/ok.txt`, {
      headers: { apikey: project.backend.anonKey },
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('default rls ok')
  })

  test('anonymous upload to a public bucket is rejected (no anon write policy)', async () => {
    const upload = await anonClient.storage.from('images').upload('anon.txt', new TextEncoder().encode('x'), { contentType: 'text/plain' })
    expect(upload.error).not.toBeNull()
  })
})
