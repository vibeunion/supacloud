import { describe, expect, test } from 'bun:test'
import { parseQuery, parseSelect } from '../src/runtime/rest/parse.js'
import { createBackend } from '../src/runtime/index.js'
import { QueryBuilder } from '../src/runtime/rest/build.js'
import type { ForeignKey, SchemaInfo, TableInfo } from '../src/runtime/db/database.js'

describe('REST query boundaries', () => {
  test.each(['toString', 'constructor', '__proto__'])('rejects inherited filter operator %s', (op) => {
    expect(() => parseQuery(new URLSearchParams({ id: `${op}.1` }))).toThrow('unknown filter operator')
  })

  test.each(['', '-1', '1.5', '1e3', '2rows', '9007199254740992'])(
    'rejects invalid pagination value %s',
    (value) => {
      for (const key of ['limit', 'offset']) {
        expect(() => parseQuery(new URLSearchParams({ [key]: value }))).toThrow(`invalid ${key}`)
      }
    },
  )

  test('retains zero pagination and explicit null ordering', () => {
    const query = parseQuery(new URLSearchParams({ limit: '0', offset: '12', order: 'id.desc.nullslast' }))
    expect(query.limits.get('')).toBe(0)
    expect(query.offsets.get('')).toBe(12)
    expect(query.order).toEqual([{ path: [], column: 'id', asc: false, nullsFirst: false }])
    expect(parseQuery(new URLSearchParams({ order: 'id' })).order)
      .toEqual([{ path: [], column: 'id', asc: true }])
  })

  test('retains text search configuration and nested boolean operators', () => {
    const query = parseQuery(new URLSearchParams({
      title: 'fts(english).safety',
      or: '(id.eq.1,and(id.gt.2,id.lt.5))',
    }))
    expect(query.conditions).toEqual([
      { kind: 'filter', path: [], column: 'title', negated: false, op: 'fts', value: 'safety', ftsConfig: 'english' },
      {
        kind: 'logic', path: [], op: 'or', negated: false, conditions: [
          { kind: 'filter', path: [], column: 'id', negated: false, op: 'eq', value: '1' },
          {
            kind: 'logic', path: [], op: 'and', negated: false, conditions: [
              { kind: 'filter', path: [], column: 'id', negated: false, op: 'gt', value: '2' },
              { kind: 'filter', path: [], column: 'id', negated: false, op: 'lt', value: '5' },
            ],
          },
        ],
      },
    ])
  })

  test('preserves aliases, casts, aggregates and relationship hints without absent fields', () => {
    expect(parseSelect('total:price.sum()::text,author:users!owner_id!inner(name),count()')).toEqual([
      { kind: 'column', name: 'price', alias: 'total', cast: 'text', aggregate: 'sum' },
      {
        kind: 'embed', name: 'users', alias: 'author', hint: 'owner_id', inner: true, spread: false,
        children: [{ kind: 'column', name: 'name' }],
      },
      { kind: 'column', name: '', aggregate: 'count' },
    ])
  })

  test('rejects missing filter, order and embed names', () => {
    expect(() => parseQuery(new URLSearchParams({ '': 'eq.1' }))).toThrow('empty filter column')
    expect(() => parseQuery(new URLSearchParams({ order: '.desc' }))).toThrow('empty order column')
    expect(() => parseSelect('(id)')).toThrow('empty embed name')
  })
})

describe('REST relationship metadata', () => {
  function schema(fk: ForeignKey): SchemaInfo {
    const table = (name: string, names: string[]): TableInfo => ({
      schema: 'public', name, primaryKey: ['id'], uniqueKeys: [['id']],
      columns: names.map((column) => ({
        name: column, udtName: 'int4', isNullable: false, hasDefault: false, isPrimaryKey: column === 'id',
      })),
    })
    return {
      tables: new Map([
        ['posts', table('posts', ['id', 'author_id'])],
        ['authors', table('authors', ['id'])],
      ]),
      foreignKeys: [fk],
    }
  }

  const fk: ForeignKey = {
    constraintName: 'posts_author_fk', srcSchema: 'public', srcTable: 'posts',
    srcColumns: ['author_id'], tgtSchema: 'public', tgtTable: 'authors', tgtColumns: ['id'],
  }

  test('constructs a correlated join and emits a count only when requested', () => {
    const builder = new QueryBuilder('public', schema(fk), parseQuery(new URLSearchParams({ select: 'id,authors(id)' })))
    const query = builder.buildSelect('posts')
    expect(query.sql).toContain('"_t0"."id" = "t0"."author_id"')
    expect(Object.hasOwn(query, 'countSql')).toBe(false)
    expect(builder.buildSelect('posts', { count: true }).countSql).toContain('count(*)')
  })

  test.each([
    { srcColumns: [], tgtColumns: [] },
    { srcColumns: ['author_id'], tgtColumns: [] },
    { srcColumns: ['author_id'], tgtColumns: ['id', 'extra'] },
    { srcColumns: ['author_id'], tgtColumns: [''] },
  ])('rejects incomplete foreign key columns %j before SQL execution', (columns) => {
    const builder = new QueryBuilder(
      'public', schema({
        ...fk, srcColumns: [...columns.srcColumns], tgtColumns: [...columns.tgtColumns],
      }), parseQuery(new URLSearchParams({ select: 'id,authors(id)' })),
    )
    expect(() => builder.buildSelect('posts')).toThrow('Incomplete foreign key column metadata')
  })
})

test('unknown conflict preference cannot turn an insert into an update', async () => {
  const backend = await createBackend({
    startRuntimeServices: false,
    log: () => {},
    migrations: [{
      name: 'rest_boundary_fixture',
      sql: 'create table public.boundary_rows (id integer primary key, value text);',
    }],
  })
  try {
    const send = (value: string, prefer: string) => backend.fetch('http://local/rest/v1/boundary_rows', {
      method: 'POST',
      headers: {
        apikey: backend.serviceRoleKey,
        authorization: `Bearer ${backend.serviceRoleKey}`,
        'content-type': 'application/json',
        prefer,
      },
      body: JSON.stringify({ id: 1, value }),
    })
    expect((await send('original', 'return=representation')).status).toBe(201)
    expect((await send('invalid-update', 'resolution=unknown,return=representation')).status).toBe(409)
    const rows = await backend.fetch('http://local/rest/v1/boundary_rows', {
      headers: { apikey: backend.serviceRoleKey, authorization: `Bearer ${backend.serviceRoleKey}` },
    })
    expect(await rows.json()).toEqual([{ id: 1, value: 'original' }])
    const updated = await send('valid-update', 'resolution=merge-duplicates,return=representation')
    expect(updated.status).toBe(201)
    expect(await updated.json()).toEqual([{ id: 1, value: 'valid-update' }])
  } finally {
    await backend.close()
  }
})
