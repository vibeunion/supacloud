import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type OpenApiObject = { [key: string]: unknown };

export interface OpenApiDocument {
  openapi: string;
  info: OpenApiObject;
  paths: OpenApiObject;
  [key: string]: unknown;
}

export class OpenApiDocumentError extends Error {
  readonly code = "OPENAPI_DOCUMENT_INVALID" as const;

  constructor() {
    super("OpenAPI document is invalid or could not be loaded.");
    this.name = "OpenApiDocumentError";
  }
}

export interface OpenApiJsonWriteResult {
  path: string;
  written: boolean;
}

export interface OpenApiExportOptions {
  modulePath: string;
  outputPath: string;
  space?: number;
}

export interface OpenApiDiffChange {
  kind: "breaking" | "non-breaking";
  code: string;
  path: string;
  message: string;
}

export interface OpenApiDiffResult {
  ok: boolean;
  breaking: OpenApiDiffChange[];
  changes: OpenApiDiffChange[];
}

const HTTP_METHODS = [
  "get", "put", "post", "delete", "options", "head", "patch", "trace",
] as const;

const COMPONENT_GROUPS = [
  "schemas", "responses", "parameters", "requestBodies", "headers", "securitySchemes",
] as const;

type SchemaDirection = "input" | "output";

function isRecord(value: unknown): value is OpenApiObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function recordValue(value: unknown): OpenApiObject | undefined {
  return isRecord(value) ? value : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function sortedKeys(value: OpenApiObject | undefined): string[] {
  return value ? Object.keys(value).sort() : [];
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function decodeJsonPointerPart(value: string): string {
  return value.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolveSchema(
  value: unknown,
  document: OpenApiDocument,
  seen = new Set<string>(),
): OpenApiObject | undefined {
  const schema = recordValue(value);
  if (!schema) return undefined;
  const ref = stringValue(schema.$ref);
  if (!ref || !ref.startsWith("#/components/schemas/")) return schema;
  if (seen.has(ref)) return schema;
  const name = decodeJsonPointerPart(ref.slice("#/components/schemas/".length));
  const components = recordValue(document.components);
  const schemas = recordValue(components?.schemas);
  const target = schemas?.[name];
  if (target === undefined) return schema;
  return resolveSchema(target, document, new Set([...seen, ref]));
}

function schemaEnum(value: OpenApiObject | undefined): unknown[] | undefined {
  return Array.isArray(value?.enum) ? value.enum : undefined;
}

function schemaProperties(value: OpenApiObject | undefined): OpenApiObject | undefined {
  return recordValue(value?.properties);
}

function schemaRequired(value: OpenApiObject | undefined): Set<string> {
  return new Set(arrayValue(value?.required).filter((item): item is string => typeof item === "string"));
}

function schemaType(value: OpenApiObject | undefined): unknown {
  return value?.type;
}

function addChange(
  changes: OpenApiDiffChange[],
  change: OpenApiDiffChange,
): void {
  if (changes.some((item) => item.kind === change.kind && item.code === change.code
    && item.path === change.path && item.message === change.message)) return;
  changes.push(change);
}

function compareSchema(
  baseValue: unknown,
  currentValue: unknown,
  baseDocument: OpenApiDocument,
  currentDocument: OpenApiDocument,
  path: string,
  direction: SchemaDirection,
  changes: OpenApiDiffChange[],
  seen = new Set<string>(),
): void {
  const baseSchema = resolveSchema(baseValue, baseDocument);
  const currentSchema = resolveSchema(currentValue, currentDocument);
  if (!baseSchema || !currentSchema) return;

  const pair = `${path}|${JSON.stringify(baseSchema)}|${JSON.stringify(currentSchema)}`;
  if (seen.has(pair)) return;
  seen.add(pair);

  if (schemaType(baseSchema) !== undefined && schemaType(currentSchema) !== undefined
    && !sameJson(schemaType(baseSchema), schemaType(currentSchema))) {
    addChange(changes, {
      kind: "breaking",
      code: "schema-type-changed",
      path,
      message: "The schema type changed.",
    });
  }

  const baseEnum = schemaEnum(baseSchema);
  const currentEnum = schemaEnum(currentSchema);
  if (baseEnum && currentEnum) {
    for (const value of baseEnum) {
      if (!currentEnum.some((candidate) => sameJson(candidate, value))) {
        addChange(changes, {
          kind: "breaking",
          code: "schema-enum-value-removed",
          path,
          message: "An enum value accepted by the previous contract was removed.",
        });
        break;
      }
    }
  }

  const baseProperties = schemaProperties(baseSchema);
  const currentProperties = schemaProperties(currentSchema);
  if (baseProperties && currentProperties) {
    for (const name of sortedKeys(baseProperties)) {
      if (currentProperties[name] === undefined) {
        const inputRemovalIsBreaking = baseSchema.additionalProperties === false;
        if (direction === "output" || inputRemovalIsBreaking) {
          addChange(changes, {
            kind: "breaking",
            code: direction === "output" ? "response-property-removed" : "request-property-removed",
            path: `${path}.properties.${name}`,
            message: direction === "output"
              ? "A property returned by the previous contract was removed."
              : "A request property was removed while additional properties are rejected.",
          });
        }
        continue;
      }
      compareSchema(
        baseProperties[name], currentProperties[name], baseDocument, currentDocument,
        `${path}.properties.${name}`, direction, changes, seen,
      );
    }
  }

  const baseRequired = schemaRequired(baseSchema);
  const currentRequired = schemaRequired(currentSchema);
  if (direction === "input") {
    for (const name of currentRequired) {
      if (!baseRequired.has(name)) {
        addChange(changes, {
          kind: "breaking",
          code: "request-property-required",
          path: `${path}.required`,
          message: `Request property '${name}' became required.`,
        });
      }
    }
    if (baseSchema.additionalProperties !== false && currentSchema.additionalProperties === false) {
      addChange(changes, {
        kind: "breaking",
        code: "request-additional-properties-rejected",
        path,
        message: "The request schema now rejects additional properties.",
      });
    }
  } else {
    for (const name of baseRequired) {
      if (!currentRequired.has(name)) {
        addChange(changes, {
          kind: "breaking",
          code: "response-property-optional",
          path: `${path}.required`,
          message: `Response property '${name}' is no longer guaranteed.`,
        });
      }
    }
  }
}

function parameterKey(value: unknown): string | undefined {
  const parameter = recordValue(value);
  const name = stringValue(parameter?.name);
  const location = stringValue(parameter?.in);
  return name && location ? `${location}:${name}` : undefined;
}

function operationParameters(pathItem: OpenApiObject, operation: OpenApiObject): Map<string, OpenApiObject> {
  const result = new Map<string, OpenApiObject>();
  for (const source of [pathItem.parameters, operation.parameters]) {
    for (const item of arrayValue(source)) {
      const parameter = recordValue(item);
      const key = parameterKey(parameter);
      if (parameter && key) result.set(key, parameter);
    }
  }
  return result;
}

function parameterSchema(value: OpenApiObject): unknown {
  return value.schema;
}

function compareParameters(
  basePathItem: OpenApiObject,
  currentPathItem: OpenApiObject,
  baseOperation: OpenApiObject,
  currentOperation: OpenApiObject,
  baseDocument: OpenApiDocument,
  currentDocument: OpenApiDocument,
  path: string,
  changes: OpenApiDiffChange[],
): void {
  const baseParameters = operationParameters(basePathItem, baseOperation);
  const currentParameters = operationParameters(currentPathItem, currentOperation);
  for (const key of [...baseParameters.keys()].sort()) {
    const baseParameter = baseParameters.get(key);
    const currentParameter = currentParameters.get(key);
    if (!baseParameter || !currentParameter) {
      addChange(changes, {
        kind: "breaking",
        code: "parameter-removed",
        path: `${path}.parameters.${key}`,
        message: "A parameter from the previous contract was removed.",
      });
      continue;
    }
    if (currentParameter.required === true && baseParameter.required !== true) {
      addChange(changes, {
        kind: "breaking",
        code: "parameter-required",
        path: `${path}.parameters.${key}`,
        message: "An optional parameter became required.",
      });
    }
    if (parameterSchema(baseParameter) !== undefined && parameterSchema(currentParameter) !== undefined) {
      compareSchema(
        parameterSchema(baseParameter), parameterSchema(currentParameter),
        baseDocument, currentDocument, `${path}.parameters.${key}.schema`, "input", changes,
      );
    }
  }
  for (const key of [...currentParameters.keys()].sort()) {
    if (baseParameters.has(key)) continue;
    const parameter = currentParameters.get(key);
    if (!parameter) continue;
    addChange(changes, {
      kind: parameter.required === true ? "breaking" : "non-breaking",
      code: parameter.required === true ? "parameter-required" : "parameter-added",
      path: `${path}.parameters.${key}`,
      message: parameter.required === true
        ? "A new required parameter was added."
        : "An optional parameter was added.",
    });
  }
}

function compareRequestBody(
  baseOperation: OpenApiObject,
  currentOperation: OpenApiObject,
  baseDocument: OpenApiDocument,
  currentDocument: OpenApiDocument,
  path: string,
  changes: OpenApiDiffChange[],
): void {
  const baseBody = recordValue(baseOperation.requestBody);
  const currentBody = recordValue(currentOperation.requestBody);
  if (!baseBody || !currentBody) {
    if (baseBody && !currentBody) {
      addChange(changes, {
        kind: "breaking",
        code: "request-body-removed",
        path: `${path}.requestBody`,
        message: "A request body from the previous contract was removed.",
      });
    } else if (!baseBody && currentBody?.required === true) {
      addChange(changes, {
        kind: "breaking",
        code: "request-body-required",
        path: `${path}.requestBody`,
        message: "A request body became required.",
      });
    } else if (!baseBody && currentBody) {
      addChange(changes, {
        kind: "non-breaking",
        code: "request-body-added",
        path: `${path}.requestBody`,
        message: "An optional request body was added.",
      });
    }
    return;
  }
  if (currentBody.required === true && baseBody.required !== true) {
    addChange(changes, {
      kind: "breaking",
      code: "request-body-required",
      path: `${path}.requestBody`,
      message: "An optional request body became required.",
    });
  }
  const baseContent = recordValue(baseBody.content);
  const currentContent = recordValue(currentBody.content);
  for (const mediaType of sortedKeys(baseContent)) {
    const baseMedia = recordValue(baseContent?.[mediaType]);
    const currentMedia = recordValue(currentContent?.[mediaType]);
    if (!baseMedia || !currentMedia) {
      addChange(changes, {
        kind: "breaking",
        code: "request-media-type-removed",
        path: `${path}.requestBody.content.${mediaType}`,
        message: "A request media type from the previous contract was removed.",
      });
      continue;
    }
    if (baseMedia.schema !== undefined && currentMedia.schema !== undefined) {
      compareSchema(
        baseMedia.schema, currentMedia.schema, baseDocument, currentDocument,
        `${path}.requestBody.content.${mediaType}.schema`, "input", changes,
      );
    }
  }
}

function compareResponses(
  baseOperation: OpenApiObject,
  currentOperation: OpenApiObject,
  baseDocument: OpenApiDocument,
  currentDocument: OpenApiDocument,
  path: string,
  changes: OpenApiDiffChange[],
): void {
  const baseResponses = recordValue(baseOperation.responses);
  const currentResponses = recordValue(currentOperation.responses);
  for (const status of sortedKeys(baseResponses)) {
    const baseResponse = recordValue(baseResponses?.[status]);
    const currentResponse = recordValue(currentResponses?.[status]);
    if (!baseResponse || !currentResponse) {
      addChange(changes, {
        kind: "breaking",
        code: "response-removed",
        path: `${path}.responses.${status}`,
        message: "A response status from the previous contract was removed.",
      });
      continue;
    }
    const baseContent = recordValue(baseResponse.content);
    const currentContent = recordValue(currentResponse.content);
    for (const mediaType of sortedKeys(baseContent)) {
      const baseMedia = recordValue(baseContent?.[mediaType]);
      const currentMedia = recordValue(currentContent?.[mediaType]);
      if (!baseMedia || !currentMedia) {
        addChange(changes, {
          kind: "breaking",
          code: "response-media-type-removed",
          path: `${path}.responses.${status}.content.${mediaType}`,
          message: "A response media type from the previous contract was removed.",
        });
        continue;
      }
      if (baseMedia.schema !== undefined && currentMedia.schema !== undefined) {
        compareSchema(
          baseMedia.schema, currentMedia.schema, baseDocument, currentDocument,
          `${path}.responses.${status}.content.${mediaType}.schema`, "output", changes,
        );
      }
    }
  }
  for (const status of sortedKeys(currentResponses)) {
    if (baseResponses?.[status] !== undefined) continue;
    addChange(changes, {
      kind: "non-breaking",
      code: "response-added",
      path: `${path}.responses.${status}`,
      message: "A response status was added.",
    });
  }
}

function compareOperation(
  basePathItem: OpenApiObject,
  currentPathItem: OpenApiObject,
  baseOperation: OpenApiObject,
  currentOperation: OpenApiObject,
  baseDocument: OpenApiDocument,
  currentDocument: OpenApiDocument,
  path: string,
  changes: OpenApiDiffChange[],
): void {
  compareParameters(
    basePathItem, currentPathItem, baseOperation, currentOperation,
    baseDocument, currentDocument, path, changes,
  );
  compareRequestBody(baseOperation, currentOperation, baseDocument, currentDocument, path, changes);
  compareResponses(baseOperation, currentOperation, baseDocument, currentDocument, path, changes);

  const baseSecurity = baseOperation.security;
  const currentSecurity = currentOperation.security;
  if (Array.isArray(currentSecurity) && currentSecurity.length > 0
    && (!Array.isArray(baseSecurity) || baseSecurity.length === 0)) {
    addChange(changes, {
      kind: "breaking",
      code: "security-requirement-added",
      path: `${path}.security`,
      message: "The operation now requires authentication or an additional security scheme.",
    });
  }
}

function compareComponents(
  baseDocument: OpenApiDocument,
  currentDocument: OpenApiDocument,
  changes: OpenApiDiffChange[],
): void {
  const baseComponents = recordValue(baseDocument.components);
  const currentComponents = recordValue(currentDocument.components);
  for (const group of COMPONENT_GROUPS) {
    const baseGroup = recordValue(baseComponents?.[group]);
    const currentGroup = recordValue(currentComponents?.[group]);
    for (const name of sortedKeys(baseGroup)) {
      if (currentGroup?.[name] !== undefined) continue;
      addChange(changes, {
        kind: "breaking",
        code: "component-removed",
        path: `components.${group}.${name}`,
        message: "A reusable component from the previous contract was removed.",
      });
    }
    for (const name of sortedKeys(currentGroup)) {
      if (baseGroup?.[name] !== undefined) continue;
      addChange(changes, {
        kind: "non-breaking",
        code: "component-added",
        path: `components.${group}.${name}`,
        message: "A reusable component was added.",
      });
    }
  }
}

export function parseOpenApiDocument(value: unknown): OpenApiDocument {
  if (!isRecord(value)
    || typeof value.openapi !== "string"
    || !/^3\.[0-9]+(?:\.[0-9]+)?$/.test(value.openapi)
    || !isRecord(value.info)
    || !isRecord(value.paths)) {
    throw new OpenApiDocumentError();
  }
  return { ...value, openapi: value.openapi, info: value.info, paths: value.paths };
}

export function serializeOpenApiJson(document: unknown, space = 2): string {
  const parsed = parseOpenApiDocument(document);
  if (!Number.isInteger(space) || space < 0 || space > 10) throw new OpenApiDocumentError();
  const serialized = JSON.stringify(parsed, null, space);
  if (serialized === undefined) throw new OpenApiDocumentError();
  return `${serialized}\n`;
}

export async function readOpenApiJson(path: string): Promise<OpenApiDocument> {
  try {
    const value: unknown = JSON.parse(await readFile(resolve(path), "utf8"));
    return parseOpenApiDocument(value);
  } catch (error) {
    if (error instanceof OpenApiDocumentError) throw error;
    throw new OpenApiDocumentError();
  }
}

export async function writeOpenApiJson(
  document: unknown,
  outputPath: string,
  space = 2,
): Promise<OpenApiJsonWriteResult> {
  const path = resolve(outputPath);
  const content = serializeOpenApiJson(document, space);
  await mkdir(dirname(path), { recursive: true });
  try {
    if (await readFile(path, "utf8") === content) return { path, written: false };
  } catch {
    // The target does not exist yet.
  }
  const temporaryPath = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  return { path, written: true };
}

export async function loadGeneratedOpenApiDocument(modulePath: string): Promise<OpenApiDocument> {
  try {
    const moduleUrl = pathToFileURL(resolve(modulePath));
    moduleUrl.searchParams.set("supacloud-openapi-export", "1");
    const loaded: unknown = await import(moduleUrl.href);
    if (!isRecord(loaded)) throw new OpenApiDocumentError();
    return parseOpenApiDocument(loaded.OPENAPI_DOCUMENT);
  } catch (error) {
    if (error instanceof OpenApiDocumentError) throw error;
    throw new OpenApiDocumentError();
  }
}

export async function exportGeneratedOpenApiJson(
  options: OpenApiExportOptions,
): Promise<OpenApiJsonWriteResult> {
  const document = await loadGeneratedOpenApiDocument(options.modulePath);
  return writeOpenApiJson(document, options.outputPath, options.space);
}

export function diffOpenApiDocuments(
  baseValue: unknown,
  currentValue: unknown,
): OpenApiDiffResult {
  const baseDocument = parseOpenApiDocument(baseValue);
  const currentDocument = parseOpenApiDocument(currentValue);
  const changes: OpenApiDiffChange[] = [];
  const basePaths = baseDocument.paths;
  const currentPaths = currentDocument.paths;

  for (const path of sortedKeys(basePaths)) {
    const basePathItem = recordValue(basePaths[path]);
    const currentPathItem = recordValue(currentPaths[path]);
    if (!basePathItem || !currentPathItem) {
      addChange(changes, {
        kind: "breaking",
        code: "path-removed",
        path: `paths.${path}`,
        message: "A path from the previous contract was removed.",
      });
      continue;
    }
    for (const method of HTTP_METHODS) {
      const baseOperation = recordValue(basePathItem[method]);
      const currentOperation = recordValue(currentPathItem[method]);
      if (!baseOperation || !currentOperation) {
        if (baseOperation) {
          addChange(changes, {
            kind: "breaking",
            code: "operation-removed",
            path: `paths.${path}.${method}`,
            message: "An operation from the previous contract was removed.",
          });
        } else if (currentOperation) {
          addChange(changes, {
            kind: "non-breaking",
            code: "operation-added",
            path: `paths.${path}.${method}`,
            message: "An operation was added to an existing path.",
          });
        }
        continue;
      }
      compareOperation(
        basePathItem, currentPathItem, baseOperation, currentOperation,
        baseDocument, currentDocument, `paths.${path}.${method}`, changes,
      );
    }
  }

  for (const path of sortedKeys(currentPaths)) {
    if (basePaths[path] !== undefined) continue;
    addChange(changes, {
      kind: "non-breaking",
      code: "path-added",
      path: `paths.${path}`,
      message: "A path was added.",
    });
  }
  compareComponents(baseDocument, currentDocument, changes);

  const breaking = changes.filter((change) => change.kind === "breaking");
  return { ok: breaking.length === 0, breaking, changes };
}

export function formatOpenApiDiff(result: OpenApiDiffResult): string {
  if (result.changes.length === 0) return "OpenAPI diff passed: no contract changes.";
  return [
    `OpenAPI diff ${result.ok ? "passed" : "failed"}: ${result.breaking.length} breaking change(s).`,
    ...result.changes.map((change) =>
      `${change.kind === "breaking" ? "BREAKING" : "NON-BREAKING"} ${change.code} at ${change.path}: ${change.message}`),
  ].join("\n");
}
