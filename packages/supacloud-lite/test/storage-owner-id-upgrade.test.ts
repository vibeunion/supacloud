import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BOOTSTRAP_SQL } from '../src/runtime/db/bootstrap.js'
import { Database } from '../src/runtime/db/database.js'
import { createPgliteEngine } from '../src/runtime/db/pglite-engine.js'

test('upgrades legacy storage ownership to owner_id without losing the owner', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-storage-owner-upgrade-'))
  const dataDir = join(rootDir, 'db')
  const owner = '26fd4f14-aaf4-4a7e-97ef-7b8be433330d'
  let database: Database | undefined

  try {
    const legacy = await createPgliteEngine(dataDir)
    try {
      await legacy.exec(BOOTSTRAP_SQL)
      await legacy.exec(`
        alter table storage.objects drop column owner_id;
        alter table storage.buckets drop column owner_id;
        insert into storage.buckets (id, name, owner) values ('legacy', 'legacy', '${owner}');
        insert into storage.objects (bucket_id, name, owner)
        values ('legacy', 'owned.txt', '${owner}');
      `)
    } finally {
      await legacy.close()
    }

    database = await Database.create(dataDir)
    const upgraded = await database.query<{ owner: string; owner_id: string }>(`
      select owner, owner_id
      from storage.objects
      where bucket_id = 'legacy' and name = 'owned.txt'
    `)
    expect(upgraded.rows[0]).toEqual({ owner, owner_id: owner })
    const upgradedBucket = await database.query<{ owner: string; owner_id: string }>(`
      select owner, owner_id from storage.buckets where id = 'legacy'
    `)
    expect(upgradedBucket.rows[0]).toEqual({ owner, owner_id: owner })
  } finally {
    await database?.close()
    await rm(rootDir, { recursive: true, force: true })
  }
}, 30_000)
