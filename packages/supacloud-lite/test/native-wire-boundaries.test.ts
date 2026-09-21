import { expect, test } from 'bun:test'
import { createServer, type Socket } from 'node:net'
import { createHmac, pbkdf2Sync } from 'node:crypto'
import { PgWireClient } from '../src/runtime/node/native/wire.js'

function frame(type: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(5)
  header.writeUInt8(type, 0)
  header.writeInt32BE(payload.length + 4, 1)
  return Buffer.concat([header, payload])
}

function auth(code: number, body = Buffer.alloc(0)): Buffer {
  const method = Buffer.alloc(4)
  method.writeInt32BE(code)
  return frame(0x52, Buffer.concat([method, body]))
}

const ready = frame(0x5a, Buffer.from('I'))
const accepted = Buffer.concat([auth(0), ready])

async function withServer(
  connection: (socket: Socket) => void,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    socket.setTimeout(1500, () => socket.destroy())
    connection(socket)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected local TCP port')
    await run(address.port)
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function connect(port: number) {
  return PgWireClient.connect({ host: '127.0.0.1', port, user: 'fixture', database: 'fixture', password: 'synthetic' })
}

test.each([-1, 0, 3])('rejects invalid PostgreSQL frame length %i during startup', async (length) => {
  const header = Buffer.alloc(5)
  header.writeUInt8(0x52, 0)
  header.writeInt32BE(length, 1)
  await withServer((socket) => socket.once('data', () => socket.write(header)), async (port) => {
    await expect(connect(port)).rejects.toThrow('message length')
  })
})

test.each([
  ['unterminated field', frame(0x45, Buffer.from('Munterminated')), 'field terminator'],
  ['missing error terminator', frame(0x45, Buffer.from('Merror\0')), 'response terminator'],
  ['premature ready', ready, 'before authentication'],
  ['invalid ready status', Buffer.concat([auth(0), frame(0x5a, Buffer.from('X'))]), 'ready status'],
] as const)('rejects %s during startup without hanging', async (_name, response, message) => {
  await withServer((socket) => socket.once('data', () => socket.write(response)), async (port) => {
    await expect(connect(port)).rejects.toThrow(message)
  })
})

function description(name = 'value', format = 0): Buffer {
  const count = Buffer.alloc(2)
  count.writeUInt16BE(1)
  const fields = Buffer.alloc(18)
  fields.writeInt32BE(25, 6)
  fields.writeInt16BE(format, 16)
  return frame(0x54, Buffer.concat([count, Buffer.from(`${name}\0`), fields]))
}

function row(value: string, declaredLength = Buffer.byteLength(value)): Buffer {
  const header = Buffer.alloc(6)
  header.writeUInt16BE(1)
  header.writeInt32BE(declaredLength, 2)
  return frame(0x44, Buffer.concat([header, Buffer.from(value)]))
}

test.each([
  ['value beyond frame', Buffer.concat([description(), row('x', 100)]), 'value length'],
  ['invalid null length', Buffer.concat([description(), row('', -2)]), 'value length'],
  ['missing columns', row('x'), 'column description'],
  ['truncated columns', frame(0x54, Buffer.from([0, 1, 0])), 'column description'],
  ['binary column', description('value', 1), 'binary column format'],
  ['unterminated error', frame(0x45, Buffer.from('Mbroken')), 'field terminator'],
] as const)('rejects malformed query response: %s', async (_name, response, message) => {
  await withServer((socket) => {
    socket.once('data', () => {
      socket.write(accepted)
      socket.once('data', () => socket.write(response))
    })
  }, async (port) => {
    const client = await connect(port)
    try {
      await expect(client.exec('select 1')).rejects.toThrow(message)
      await expect(client.exec('select 2')).rejects.toThrow('connection closed')
    } finally {
      await client.close()
    }
  })
})

test('handles fragmented result frames and preserves prototype-named columns as data', async () => {
  const response = Buffer.concat([
    description('__proto__'), row('value'), frame(0x43, Buffer.from('SELECT 1\0')), ready,
  ])
  await withServer((socket) => {
    socket.once('data', () => {
      socket.write(accepted)
      socket.once('data', () => {
        socket.write(response.subarray(0, 3))
        setImmediate(() => socket.write(response.subarray(3)))
      })
    })
  }, async (port) => {
    const client = await connect(port)
    try {
      const results = await client.exec('select 1')
      expect(results).toEqual([{ rows: [Object.fromEntries([['__proto__', 'value']])], affectedRows: 1 }])
      const first = results[0]?.rows[0]
      expect(Object.getPrototypeOf(first)).toBe(Object.prototype)
    } finally {
      await client.close()
    }
  })
})

test.each([
  ['missing server signature', 'e=authentication-failed', 'signature verification failed'],
  ['wrong server signature', `v=${Buffer.alloc(32).toString('base64')}`, 'signature verification failed'],
] as const)('rejects SCRAM %s', async (_name, final, message) => {
  await withServer((socket) => {
    socket.once('data', () => {
      socket.write(auth(10, Buffer.from('SCRAM-SHA-256\0\0')))
      socket.once('data', (initial: Buffer) => {
        const nonce = initial.toString().match(/r=([^,]+)$/)?.[1]
        if (!nonce) throw new Error('Missing fixture client nonce')
        socket.write(auth(11, Buffer.from(`r=${nonce}server,s=c2FsdA==,i=4096`)))
        socket.once('data', () => socket.write(auth(12, Buffer.from(final))))
      })
    })
  }, async (port) => {
    await expect(connect(port)).rejects.toThrow(message)
  })
})

test('accepts a verified SCRAM exchange and executes a query', async () => {
  await withServer((socket) => {
    socket.once('data', () => {
      socket.write(auth(10, Buffer.from('SCRAM-SHA-256\0\0')))
      socket.once('data', (initial: Buffer) => {
        const firstBare = initial.toString().match(/n,,(n=[^,]*,r=[^,]+)$/)?.[1]
        const nonce = firstBare?.match(/,r=(.+)$/)?.[1]
        if (!firstBare || !nonce) throw new Error('Missing fixture client first message')
        const serverFirst = `r=${nonce}server,s=c2FsdA==,i=4096`
        socket.write(auth(11, Buffer.from(serverFirst)))
        socket.once('data', (final: Buffer) => {
          const finalWithoutProof = final.subarray(5).toString().split(',p=')[0]
          if (!finalWithoutProof) throw new Error('Missing fixture client final message')
          const salted = pbkdf2Sync('synthetic', Buffer.from('salt'), 4096, 32, 'sha256')
          const serverKey = createHmac('sha256', salted).update('Server Key').digest()
          const signature = createHmac('sha256', serverKey)
            .update(`${firstBare},${serverFirst},${finalWithoutProof}`).digest('base64')
          socket.write(Buffer.concat([auth(12, Buffer.from(`v=${signature}`)), accepted]))
          socket.once('data', () => socket.write(Buffer.concat([
            description(), row('authenticated'), frame(0x43, Buffer.from('SELECT 1\0')), ready,
          ])))
        })
      })
    })
  }, async (port) => {
    const client = await connect(port)
    try {
      expect(await client.exec('select 1')).toEqual([{ rows: [{ value: 'authenticated' }], affectedRows: 1 }])
    } finally {
      await client.close()
    }
  })
})

test.each(['0', '-1', '1junk', '1e9', '1000001'])('rejects invalid SCRAM work factor %s', async (iterations) => {
  await withServer((socket) => {
    socket.once('data', () => {
      socket.write(auth(10, Buffer.from('SCRAM-SHA-256\0\0')))
      socket.once('data', (initial: Buffer) => {
        const nonce = initial.toString().match(/r=([^,]+)$/)?.[1]
        if (!nonce) throw new Error('Missing fixture client nonce')
        socket.write(auth(11, Buffer.from(`r=${nonce}server,s=c2FsdA==,i=${iterations}`)))
      })
    })
  }, async (port) => {
    await expect(connect(port)).rejects.toThrow('SCRAM:')
  })
})
