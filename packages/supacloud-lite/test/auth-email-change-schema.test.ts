import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from '../src/runtime/db/database.js'
import { BOOTSTRAP_SQL } from '../src/runtime/db/bootstrap.js'

describe('Auth email change schema upgrade', () => {
  let db: Database | undefined

  beforeAll(async () => { db = await Database.create() }, 60_000)
  afterAll(async () => { await db?.close() })

  test('adds email-change columns when bootstrapping an existing full database', async () => {
    await db!.exec(`
      alter table auth.users drop column email_change;
      alter table auth.users drop column email_change_sent_at;
      alter table auth.users drop column email_change_token_new;
      alter table auth.users drop column email_change_token_current;
      alter table auth.users drop column email_change_confirm_status;
    `)

    await db!.exec(BOOTSTRAP_SQL)

    const columns = await db!.query<{ column_name: string }>(
      `select column_name
       from information_schema.columns
       where table_schema = 'auth' and table_name = 'users'
         and column_name in (
           'email_change',
           'email_change_sent_at',
           'email_change_token_new',
           'email_change_token_current',
           'email_change_confirm_status'
         )
       order by column_name`,
    )
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      'email_change',
      'email_change_confirm_status',
      'email_change_sent_at',
      'email_change_token_current',
      'email_change_token_new',
    ])
  })
})
