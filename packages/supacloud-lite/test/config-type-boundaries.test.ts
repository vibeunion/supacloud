import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getByteSize, getDurationSeconds, getInt, getString, getStringArray,
  loadConfigToml, parseConfigToml, tableAt,
} from '../src/runtime/node/config-toml.js'
import { cronMatches } from '../src/runtime/cron/service.js'

test('TOML parsing retains escaped strings, quoted keys, inline tables and multiline arrays', () => {
  const root = parseConfigToml(`
[auth]
site_url = "https://example.test/path#fragment" # ignored comment
label = "say \\"hello\\" # retained"
additional_redirect_urls = [
  "https://example.test/a,b",
  "",
  "env(REDIRECT)",
]
[functions."dotted.name"]
verify_jwt = false
[lite]
graphql = { enabled = true, max_request_body_bytes = 1_024 }
`, { REDIRECT: 'https://example.test/c' })
  const auth = tableAt(root, 'auth')
  expect(getString(auth, 'site_url')).toBe('https://example.test/path#fragment')
  expect(getString(auth, 'label')).toBe('say "hello" # retained')
  expect(getStringArray(auth, 'additional_redirect_urls')).toEqual([
    'https://example.test/a,b', '', 'https://example.test/c',
  ])
  expect(tableAt(root, 'functions')?.children.get('dotted.name')?.values.get('verify_jwt')).toBe('false')
  expect(getInt(tableAt(root, 'lite.graphql'), 'max_request_body_bytes')).toBe(1024)
})

test.each([
  '[auth]\nenabled = true\nenabled = false',
  '[auth]\nenabled = tru',
  '[auth]\nsite_url = "unterminated',
  '[auth]\nredirects = [ "unfinished"',
])('rejects malformed configuration instead of silently applying defaults: %s', (text) => {
  expect(() => parseConfigToml(text)).toThrow()
})

test('configuration absence is allowed but an unreadable configuration is not', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lite-config-boundary-'))
  try {
    expect(loadConfigToml(root).values.size).toBe(0)
    await mkdir(join(root, 'supabase', 'config.toml'), { recursive: true })
    expect(() => loadConfigToml(root)).toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test.each(['12junk', '1.5', '1e3', '9007199254740992'])('rejects malformed integer settings %s', (value) => {
  const root = parseConfigToml(`count = "${value}"`)
  expect(getInt(root, 'count')).toBeUndefined()
})

test.each(['12junk', '1.5', '10seconds', '-1', '9007199254740991h'])('rejects malformed duration settings %s', (value) => {
  expect(getDurationSeconds(parseConfigToml(`duration = "${value}"`), 'duration')).toBeUndefined()
})

test('retains valid numeric settings including zero and rejects byte overflow', () => {
  const root = parseConfigToml(`
zero = 0
count = -42
duration = "2h"
size = "1.5MiB"
huge = "9007199254740991GB"
`)
  expect(getInt(root, 'zero')).toBe(0)
  expect(getInt(root, 'count')).toBe(-42)
  expect(getDurationSeconds(root, 'duration')).toBe(7200)
  expect(getByteSize(root, 'size')).toBe(1572864)
  expect(getByteSize(root, 'huge')).toBeUndefined()
})

test.each(['*/0', '*/-1', '*/1junk', '*/1.5', '*/1/2', '1-2-3', '-1', '0-99', '5-1', '1e1', '0,*/0', '0,bad', '0,'])(
  'invalid cron fields never schedule a job: %s', (field) => {
    for (let minute = 0; minute < 60; minute++) {
      expect(cronMatches(`${field} * * * *`, new Date(Date.UTC(2026, 0, 1, 0, minute)))).toBe(false)
    }
  },
)

test('valid cron steps, lists and UTC fields retain their matching behavior', () => {
  const date = new Date('2026-01-01T09:15:00Z')
  expect(cronMatches('*/15 9 1 1 4', date)).toBe(true)
  expect(cronMatches('0,15,30 9 * * *', date)).toBe(true)
  expect(cronMatches('5-25/10 9 * * *', date)).toBe(true)
  expect(cronMatches('*/10 9 * * *', date)).toBe(false)
})
