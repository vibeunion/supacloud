import { describe, expect, mock, test } from 'bun:test';
import { createRpcClient, defineRpcContract, RpcContractError } from './index';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
  return value as Record<string, unknown>;
}

const contract = defineRpcContract({
  args(value) {
    const record = object(value);
    if (typeof record.id !== 'string') throw new Error('sensitive argument');
    return { id: record.id };
  },
  result(value) {
    const record = object(value);
    if (typeof record.version !== 'number') throw new Error('sensitive result');
    return { version: record.version };
  },
});

describe('typed RPC contracts', () => {
  test('validates both boundaries and sends projected arguments through the supplied client', async () => {
    const rpc = mock(async (_name: string, _args: Record<string, unknown>) => ({
      data: { version: 2, internal: 'not returned' }, error: null,
    }));
    const client = createRpcClient({ rpc }, { update_item: contract });
    const result = await client.call('update_item', { id: 'item', extra: 'not sent' } as { id: string });
    expect(rpc).toHaveBeenCalledWith('update_item', { id: 'item' });
    expect(result).toEqual({ ok: true, data: { version: 2 }, error: null });
    if (result.ok) {
      const version: number = result.data.version;
      expect(version).toBe(2);
    }
  });

  test('rejects invalid arguments before transport without exposing decoder errors', async () => {
    const rpc = mock(async () => ({ data: null, error: null }));
    const client = createRpcClient({ rpc }, { update_item: contract });
    await expect(client.call('update_item', { id: 1 } as unknown as { id: string }))
      .rejects.toMatchObject({ code: 'RPC_CONTRACT_INVALID', phase: 'args' });
    expect(rpc).not.toHaveBeenCalled();
    await expect(client.call('update_item', null as unknown as { id: string }))
      .rejects.toThrow('RPC contract validation failed (args)');
  });

  test.each([null, {}, { version: '2' }, []].map(data => [data]))('rejects malformed successful results without replaying a write: %j', async (data) => {
    const rpc = mock(async () => ({ data, error: null }));
    const client = createRpcClient({ rpc }, { update_item: contract });
    await expect(client.call('update_item', { id: 'item' }))
      .rejects.toMatchObject({ name: 'RpcContractError', phase: 'result' });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  test('preserves database failures and never decodes partial data', async () => {
    const error = { code: '42501', message: 'denied' };
    const resultDecoder = mock(contract.result);
    const client = createRpcClient({ rpc: async () => ({ data: { version: 3 }, error }) }, {
      update_item: { ...contract, result: resultDecoder },
    });
    expect(await client.call('update_item', { id: 'item' }))
      .toEqual({ ok: false, data: null, error });
    expect(resultDecoder).not.toHaveBeenCalled();
  });

  test.each([null, [], {}, { data: { version: 1 } }, { error: null }].map(value => [value]))(
    'rejects malformed transport envelopes without decoding or retrying: %j', async (value) => {
      const rpc = mock(async () => value as { data: unknown; error: unknown });
      const resultDecoder = mock(contract.result);
      const client = createRpcClient({ rpc }, {
        update_item: { ...contract, result: resultDecoder },
      });
      await expect(client.call('update_item', { id: 'item' }))
        .rejects.toMatchObject({ phase: 'result' });
      expect(resultDecoder).not.toHaveBeenCalled();
      expect(rpc).toHaveBeenCalledTimes(1);
    },
  );

  test('permits null only when the declared decoder accepts it', async () => {
    const client = createRpcClient({ rpc: async () => ({ data: null, error: null }) }, {
      find_item: defineRpcContract({
        args: contract.args,
        result: (value) => value === null ? null : contract.result(value),
      }),
    });
    expect(await client.call('find_item', { id: 'missing' }))
      .toEqual({ ok: true, data: null, error: null });
  });

  test('rejects undeclared and prototype names before making requests', async () => {
    const rpc = mock(async () => ({ data: {}, error: null }));
    const client = createRpcClient({ rpc }, { update_item: contract });
    for (const name of ['toString', '__proto__', 'unregistered']) {
      await expect(Reflect.apply(client.call, client, [name, {}]))
        .rejects.toBeInstanceOf(RpcContractError);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  test('snapshots decoder registrations', async () => {
    const mutable = { ...contract };
    const client = createRpcClient({ rpc: async () => ({ data: {}, error: null }) }, { update_item: mutable });
    mutable.result = () => ({ version: 999 });
    await expect(client.call('update_item', { id: 'item' })).rejects.toBeInstanceOf(RpcContractError);
  });

  test('does not retry rejected transports', async () => {
    const error = new Error('network failure');
    const rpc = mock(async () => { throw error; });
    await expect(createRpcClient({ rpc }, { update_item: contract }).call('update_item', { id: 'item' }))
      .rejects.toBe(error);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

// These calls are compile-time fixtures, not runtime assertions.
function typeAssertions() {
  const client = createRpcClient({ rpc: async () => ({ data: {}, error: null }) }, {
    update_item: contract,
    find_by_version: defineRpcContract({ args: (value) => ({ version: Number(value) }), result: String }),
  });
  // @ts-expect-error Only declared names are callable.
  void client.call('missing', { id: 'item' });
  // @ts-expect-error Arguments are inferred from the selected contract.
  void client.call('update_item', { id: 1 });
  // @ts-expect-error Another registration must not widen the selected arguments.
  void client.call('update_item', { version: 1 });
  void client.call('update_item', { id: 'item' }).then((result) => {
    if (result.ok) {
      // @ts-expect-error Result fields are inferred from the decoder.
      const version: string = result.data.version;
      void version;
    }
  });
}
void typeAssertions;
