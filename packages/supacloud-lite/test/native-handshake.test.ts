import { expect, test } from 'bun:test'
import { createServer, type Socket } from 'node:net'
import { PgWireClient } from '../src/runtime/node/native/wire.js'

test('PostgreSQL closing during startup rejects rather than hanging', async () => {
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.once('data', () => socket.end())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('fixture requires a TCP port')
    await expect(PgWireClient.connect({ host: '127.0.0.1', port: address.port, user: 'postgres', database: 'postgres' }))
      .rejects.toThrow('handshake')
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}, 5000)
