import type { Static, TSchema } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { Value } from "@sinclair/typebox/value";
import { createTransactionalCommand } from "./transactional";
import type { CommandIdentity, ContractDecoder } from "@supacloud/contracts";
import type { CommandStore } from "./store";
import type { PersistentCommandDefinition } from "./context";
import type { ExecutionPolicyOptions } from "./execution-policy";

type TransactionOf<Store extends CommandStore<unknown>> =
  Store extends CommandStore<infer Transaction> ? Transaction : never;

export interface TypeBoxCommandSchemas<InputSchema extends TSchema, ResultSchema extends TSchema> {
  readonly input: InputSchema;
  readonly result: ResultSchema;
}

export type TypeBoxCommandDefinition<
  InputSchema extends TSchema,
  ResultSchema extends TSchema,
  Store extends CommandStore<unknown>,
> = Omit<
  PersistentCommandDefinition<
    NoInfer<Static<InputSchema>>,
    NoInfer<Static<ResultSchema>>,
    NoInfer<TransactionOf<Store>>
  >,
  "store" | "input" | "result"
> & {
  readonly store: Store;
  readonly executionPolicy?: Omit<ExecutionPolicyOptions, "kind">;
  readonly schemas: TypeBoxCommandSchemas<InputSchema, ResultSchema>;
  execute(
    transaction: NoInfer<TransactionOf<Store>>,
    input: NoInfer<Static<InputSchema>>,
    identity: CommandIdentity,
    signal: AbortSignal,
  ): Promise<NoInfer<Static<ResultSchema>>>;
};

function decoder<Schema extends TSchema>(schema: Schema): ContractDecoder<Static<Schema>> {
  // Isolate the compiled contract from subsequent edits to the caller's schema.
  const validator = TypeCompiler.Compile(Value.Clone(schema));
  return (value: unknown): Static<Schema> => {
    if (!validator.Check(value)) throw new TypeError("Invalid command schema value");
    return value;
  };
}

/**
 * Schema-first, JSON-preserving use case. Validation does not coerce, apply
 * defaults or run TypeBox transforms; types describe the encoded JSON shape.
 * Storage, authorization, receipts and audit stay with the existing executor.
 */
export function createTypeBoxTransactionalCommand<
  const InputSchema extends TSchema,
  const ResultSchema extends TSchema,
  Store extends CommandStore<unknown>,
>(definition: TypeBoxCommandDefinition<InputSchema, ResultSchema, Store>) {
  const command = createTransactionalCommand({
    ...definition,
    input: decoder(definition.schemas.input),
    result: decoder(definition.schemas.result),
  });

  return Object.freeze({
    kind: command.kind,
    execute(identity: CommandIdentity, key: string, value: Static<InputSchema>, signal?: AbortSignal) {
      return command.execute(identity, key, value, signal);
    },
    lookup(identity: CommandIdentity, key: string, value: Static<InputSchema>) {
      return command.lookup(identity, key, value);
    },
    // Protocol adapters enter through unknown; application callers use execute.
    executeUnknown: command.execute,
    lookupUnknown: command.lookup,
    lookupByReference: command.lookupByReference,
  });
}
