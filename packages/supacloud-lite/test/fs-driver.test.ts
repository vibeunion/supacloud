import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FsStorageDriver } from '../src/runtime/node/fs-driver.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe('FsStorageDriver', () => {
  test('returns a lazy Bun file for existing objects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supacloud-lite-storage-'))
    temporaryDirectories.push(root)
    const driver = new FsStorageDriver(root)
    await driver.put('images/source.png', new Uint8Array([1, 2, 3]))

    const source = await driver.getBlob('images/source.png')

    expect(source).not.toBeNull()
    expect(source).toBeInstanceOf(Blob)
    expect(new Uint8Array(await source!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect(await driver.getBlob('images/missing.png')).toBeNull()
  })
})
