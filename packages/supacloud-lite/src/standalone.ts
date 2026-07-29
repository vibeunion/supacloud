// Bun 只会把显式导入的静态资源写入单文件可执行程序；standalone
// 入口负责注入核心资源，并临时释放 PGlite 只能通过文件系统读取的扩展包。
import pgliteWasm from '../node_modules/@electric-sql/pglite/dist/pglite.wasm' with { type: 'file' }
import initdbWasm from '../node_modules/@electric-sql/pglite/dist/initdb.wasm' with { type: 'file' }
import pgliteData from '../node_modules/@electric-sql/pglite/dist/pglite.data' with { type: 'file' }
import uuidOssp from '../node_modules/@electric-sql/pglite/dist/uuid-ossp.tar.gz' with { type: 'file' }
import pgcrypto from '../node_modules/@electric-sql/pglite/dist/pgcrypto.tar.gz' with { type: 'file' }
import citext from '../node_modules/@electric-sql/pglite/dist/citext.tar.gz' with { type: 'file' }
import pgTrgm from '../node_modules/@electric-sql/pglite/dist/pg_trgm.tar.gz' with { type: 'file' }
import ltree from '../node_modules/@electric-sql/pglite/dist/ltree.tar.gz' with { type: 'file' }
import hstore from '../node_modules/@electric-sql/pglite/dist/hstore.tar.gz' with { type: 'file' }
import fuzzystrmatch from '../node_modules/@electric-sql/pglite/dist/fuzzystrmatch.tar.gz' with { type: 'file' }
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  STANDALONE_PGLITE_ASSETS,
  type StandaloneExtensionName,
  type StandalonePgliteAssets,
} from './standalone-assets-protocol.js'

const extensionSources = {
  uuid_ossp: { source: uuidOssp, filename: 'uuid-ossp.tar.gz' },
  pgcrypto: { source: pgcrypto, filename: 'pgcrypto.tar.gz' },
  citext: { source: citext, filename: 'citext.tar.gz' },
  pg_trgm: { source: pgTrgm, filename: 'pg_trgm.tar.gz' },
  ltree: { source: ltree, filename: 'ltree.tar.gz' },
  hstore: { source: hstore, filename: 'hstore.tar.gz' },
  fuzzystrmatch: { source: fuzzystrmatch, filename: 'fuzzystrmatch.tar.gz' },
} satisfies Record<StandaloneExtensionName, { source: string; filename: string }>

const pgliteAssets: StandalonePgliteAssets = {
  pgliteWasmModule: await WebAssembly.compile(await Bun.file(pgliteWasm).arrayBuffer()),
  initdbWasmModule: await WebAssembly.compile(await Bun.file(initdbWasm).arrayBuffer()),
  fsBundle: Bun.file(pgliteData),
  async prepareExtensionBundles() {
    const directory = await mkdtemp(join(tmpdir(), 'supacloud-lite-pglite-'))
    try {
      await chmod(directory, 0o700)
      const entries = await Promise.all(Object.entries(extensionSources).map(async ([name, asset]) => {
        const destination = join(directory, asset.filename)
        await Bun.write(destination, Bun.file(asset.source))
        return [name, pathToFileURL(destination)] as const
      }))
      return {
        bundles: Object.fromEntries(entries) as Record<StandaloneExtensionName, URL>,
        cleanup: () => rm(directory, { recursive: true, force: true }),
      }
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  },
}

// npm 入口不设置该符号，因此仍沿用 PGlite 包自身的资源定位逻辑。
;(globalThis as typeof globalThis & { [key: symbol]: unknown })[STANDALONE_PGLITE_ASSETS] = pgliteAssets

await import('./cli.js')
