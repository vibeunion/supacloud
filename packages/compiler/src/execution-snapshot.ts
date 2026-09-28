import { isAbsolute } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { createContextPack, createExecutionPlans } from "./inspect";
import { createDiagnosticRepairPlan } from "./repair-plan";
import type { ApplicationGraph } from "./types";

const closed = { additionalProperties: false } as const;
const text = Type.String({ minLength: 1, maxLength: 512, pattern: "^[^\\u0000-\\u001f\\u007f]+$" });
const kind = Type.Union([Type.Literal("route"), Type.Literal("command"), Type.Literal("job")]);
const SnapshotSchema = Type.Object({
  version: Type.Literal(1),
  plans: Type.Array(Type.Object({
    module: text, kind, name: text, command: Type.Optional(text), stages: Type.Array(text),
  }, closed)),
  commandAliases: Type.Array(Type.Object({ module: text, name: text, alias: text }, closed)),
  contexts: Type.Array(Type.Object({
    subject: text, aliases: Type.Array(text),
    modules: Type.Array(Type.Object({ name: text, file: Type.Optional(text) }, closed)),
    files: Type.Array(text),
    diagnostics: Type.Array(Type.Object({
      code: text, severity: Type.Union([Type.Literal("error"), Type.Literal("warn")]),
      file: Type.Optional(text), line: Type.Optional(Type.Integer({ minimum: 1 })),
      repair: Type.Optional(Type.Object({
        type: text,
        readiness: Type.Union([Type.Literal("preview"), Type.Literal("input-required"), Type.Literal("manual")]),
      }, closed)),
    }, closed)),
  }, closed)),
}, closed);

export type ExecutionSnapshot = Static<typeof SnapshotSchema>;
export const EXECUTION_SNAPSHOT_MAX_BYTES = 1_048_576;
const indices = Type.Array(Type.Integer({ minimum: 0 }));
const WireSnapshotSchema = Type.Object({
  version: Type.Literal(1),
  plans: SnapshotSchema.properties.plans,
  commandAliases: SnapshotSchema.properties.commandAliases,
  modules: SnapshotSchema.properties.contexts.items.properties.modules,
  files: SnapshotSchema.properties.contexts.items.properties.files,
  diagnostics: SnapshotSchema.properties.contexts.items.properties.diagnostics,
  contexts: Type.Array(Type.Object({
    subject: text, aliases: Type.Array(text), modules: indices, files: indices, diagnostics: indices,
  }, closed)),
}, closed);

export function executionSourceFile(file: string | undefined): string | undefined {
  if (!file || isAbsolute(file) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(file) || file.startsWith("\\")
    || file.split(/[\\/]/).includes("..") || file.length > 512 || /[\u0000-\u001f\u007f]/.test(file)) return undefined;
  return file;
}

/** Persist structural metadata only, never expressions, request data or diagnostic messages. */
export function createExecutionSnapshot(graph: ApplicationGraph, subjects = graph.modules.map(module => module.name)): ExecutionSnapshot {
  return {
    version: 1, plans: createExecutionPlans(graph),
    commandAliases: graph.modules.flatMap(module => module.commands.map(command =>
      ({ module: module.name, name: command.name, alias: command.className }))),
    contexts: subjects.map(subject => {
      const context = createContextPack(graph, subject);
      const owner = graph.modules.find(module => module.name === context.subject)!;
      return {
        subject: context.subject,
        aliases: [...new Set([
          owner.className,
          ...owner.providers.flatMap(provider => [provider.token, ...(provider.useClass ? [provider.useClass] : [])]),
          ...owner.controllers.map(controller => controller.className),
          ...owner.commands.flatMap(command => [command.name, command.className]),
          ...(owner.jobs ?? []).flatMap(job => [job.name, job.className, job.serviceKey]),
          ...owner.queries.flatMap(query => [query.name, query.className]),
        ])],
        modules: context.modules.map(module => ({
          name: module.name, ...(executionSourceFile(module.file) ? { file: executionSourceFile(module.file) } : {}),
        })),
        // Invalid paths remain represented by omission counts in the current-source API.
        files: context.files,
        diagnostics: context.diagnostics.map(diagnostic => {
          const repair = createDiagnosticRepairPlan([diagnostic])[0];
          const file = executionSourceFile(diagnostic.file);
          return {
            code: diagnostic.code, severity: diagnostic.severity,
            ...(file ? { file } : {}),
            ...(Number.isSafeInteger(diagnostic.line) && diagnostic.line! > 0 ? { line: diagnostic.line } : {}),
            ...(repair ? { repair: { type: repair.type, readiness: repair.readiness } } : {}),
          };
        }),
      };
    }),
  };
}

export function parseExecutionSnapshot(value: unknown): ExecutionSnapshot {
  if (!Value.Check(WireSnapshotSchema, value)) throw new Error("Invalid execution snapshot.");
  function select<T>(table: T[], indices: number[]): T[] {
    return indices.map(index => {
      const item = table[index];
      if (item === undefined) throw new Error("Invalid execution snapshot reference.");
      return item;
    });
  }
  const expanded: ExecutionSnapshot = {
    version: value.version, plans: value.plans, commandAliases: value.commandAliases,
    contexts: value.contexts.map(context => ({
      subject: context.subject, aliases: context.aliases,
      modules: select(value.modules, context.modules),
      files: select(value.files, context.files),
      diagnostics: select(value.diagnostics, context.diagnostics),
    })),
  };
  if (new Set(expanded.contexts.map(context => context.subject)).size !== expanded.contexts.length
    || expanded.contexts.some(context => [
      ...context.files, ...context.modules.flatMap(module => module.file ?? []),
      ...context.diagnostics.flatMap(diagnostic => diagnostic.file ?? []),
    ].some(file => executionSourceFile(file) !== file))) {
    throw new Error("Invalid execution snapshot.");
  }
  return expanded;
}

function dictionary<T>() {
  const values: T[] = [];
  const indices = new Map<string, number>();
  return {
    values,
    add(value: T): number {
      const key = JSON.stringify(value);
      const found = indices.get(key);
      if (found !== undefined) return found;
      const index = values.length;
      indices.set(key, index);
      values.push(value);
      return index;
    },
  };
}

export function serializedExecutionSnapshot(graph: ApplicationGraph): string {
  const snapshot = createExecutionSnapshot(graph);
  const modules = dictionary<ExecutionSnapshot["contexts"][number]["modules"][number]>();
  const files = dictionary<string>();
  const diagnostics = dictionary<ExecutionSnapshot["contexts"][number]["diagnostics"][number]>();
  const contexts = snapshot.contexts.map(context => ({
    subject: context.subject, aliases: context.aliases,
    modules: context.modules.map(module => modules.add(module)),
    files: context.files.flatMap(file => executionSourceFile(file) ?? []).map(file => files.add(file)),
    diagnostics: context.diagnostics.map(diagnostic => diagnostics.add(diagnostic)),
  }));
  const wire = { version: 1, plans: snapshot.plans, commandAliases: snapshot.commandAliases,
    modules: modules.values, files: files.values, diagnostics: diagnostics.values, contexts };
  const json = JSON.stringify(wire);
  if (Buffer.byteLength(json, "utf8") > EXECUTION_SNAPSHOT_MAX_BYTES) throw new Error("Execution snapshot exceeds byte budget.");
  parseExecutionSnapshot(wire);
  return json;
}
