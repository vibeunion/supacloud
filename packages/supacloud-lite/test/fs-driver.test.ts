import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, parse, relative, sep } from 'node:path'
import { FsStorageDriver } from '../src/runtime/node/fs-driver.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe('FsStorageDriver', () => {
  test.each(['', sep, sep + sep])('accepts a storage root with suffix %j', async (suffix) => {
    const root = await mkdtemp(join(tmpdir(), 'supacloud-lite-storage-'))
    temporaryDirectories.push(root)
    const driver = new FsStorageDriver(root + suffix)
    const key = 'documents/source.txt'
    const data = new Uint8Array([1, 2, 3])

    await driver.put(key, data)
    expect(await driver.get(key)).toEqual(data)
    expect(new Uint8Array(await (await driver.getBlob(key))!.arrayBuffer())).toEqual(data)
    await driver.delete(key)
    expect(await driver.get(key)).toBeNull()
    expect(await driver.getBlob(key)).toBeNull()
  })

  test('anchors a dot root to its construction directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supacloud-lite-storage-'))
    temporaryDirectories.push(root)
    const previous = process.cwd()
    try {
      process.chdir(root)
      const driver = new FsStorageDriver('.')
      await driver.put('source.txt', new Uint8Array([4, 5, 6]))
      process.chdir(previous)
      expect(await driver.get('source.txt')).toEqual(new Uint8Array([4, 5, 6]))
      await driver.delete('source.txt')
      expect(await driver.get('source.txt')).toBeNull()
    } finally {
      process.chdir(previous)
    }
  })

  test('rejects the root itself and sibling paths for every operation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supacloud-lite-storage-'))
    temporaryDirectories.push(root)
    for (const suffix of ['', sep]) {
      const driver = new FsStorageDriver(root + suffix)
      for (const key of ['', '.', 'nested/..', '../outside.txt', `../${basename(root)}-sibling/source.txt`]) {
        await expect(driver.put(key, new Uint8Array([1]))).rejects.toThrow('invalid storage key')
        await expect(driver.get(key)).rejects.toThrow('invalid storage key')
        await expect(driver.getBlob(key)).rejects.toThrow('invalid storage key')
        await expect(driver.delete(key)).rejects.toThrow('invalid storage key')
        await expect(driver.deleteMany([key])).rejects.toThrow('invalid storage key')
      }
    }
  })

  test('supports a filesystem root without a double-separator boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supacloud-lite-storage-'))
    temporaryDirectories.push(root)
    const volumeRoot = parse(root).root
    const driver = new FsStorageDriver(volumeRoot)
    const key = relative(volumeRoot, join(root, 'source.txt'))
    await driver.put(key, new Uint8Array([7]))
    expect(await driver.get(key)).toEqual(new Uint8Array([7]))
    await driver.deleteMany([key])
    expect(await driver.get(key)).toBeNull()
    await expect(driver.delete('.')).rejects.toThrow('invalid storage key')
  })

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
