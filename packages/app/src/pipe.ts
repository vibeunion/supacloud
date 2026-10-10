/**
 * Angular-style Pipes & Transformation Suite (@angular/core).
 * Enables pure and declarative data transformations for route responses,
 * payloads, and presentation layers.
 */

export interface PipeTransform<T = unknown, R = unknown> {
  transform(value: T, ...args: unknown[]): R;
}

export interface PipeMetadata {
  name: string;
  pure?: boolean;
  standalone?: boolean;
}

const PIPE_METADATA_KEY = Symbol.for("supacloud.pipe");

type PipeTarget = Function & { [PIPE_METADATA_KEY]?: PipeMetadata };
interface ReflectMetadataApi {
  defineMetadata?: (key: symbol, value: PipeMetadata, target: Function) => void;
  getMetadata?: (key: symbol, target: Function) => unknown;
}

function pipeTarget(target: Function): PipeTarget {
  return target as PipeTarget;
}

export function Pipe(options: PipeMetadata): ClassDecorator {
  return (target: Function) => {
    const meta: PipeMetadata = {
      pure: true,
      standalone: true,
      ...options,
    };
    const metadata = Reflect as typeof Reflect & ReflectMetadataApi;
    if (typeof metadata.defineMetadata === "function") {
      metadata.defineMetadata(PIPE_METADATA_KEY, meta, target);
    }
    pipeTarget(target)[PIPE_METADATA_KEY] = meta;
  };
}

export function getPipeMetadata(target: Function | null | undefined): PipeMetadata | undefined {
  if (!target) return undefined;
  const metadata = Reflect as typeof Reflect & ReflectMetadataApi;
  if (typeof metadata.getMetadata === "function") {
    const meta = metadata.getMetadata(PIPE_METADATA_KEY, target);
    if (meta && typeof meta === "object" && "name" in meta && typeof meta.name === "string") {
      return meta as PipeMetadata;
    }
  }
  return pipeTarget(target)[PIPE_METADATA_KEY];
}

/**
 * Transforms text to uppercase.
 */
@Pipe({ name: "uppercase", pure: true })
export class UpperCasePipe implements PipeTransform<string | null | undefined, string> {
  transform(value: string | null | undefined): string {
    return value != null ? String(value).toUpperCase() : "";
  }
}

/**
 * Transforms text to lowercase.
 */
@Pipe({ name: "lowercase", pure: true })
export class LowerCasePipe implements PipeTransform<string | null | undefined, string> {
  transform(value: string | null | undefined): string {
    return value != null ? String(value).toLowerCase() : "";
  }
}

/**
 * Trims leading and trailing whitespace.
 */
@Pipe({ name: "trim", pure: true })
export class TrimPipe implements PipeTransform<string | null | undefined, string> {
  transform(value: string | null | undefined): string {
    return value != null ? String(value).trim() : "";
  }
}

/**
 * Serializes value into a formatted JSON string.
 */
@Pipe({ name: "json", pure: true })
export class JsonPipe implements PipeTransform<unknown, string> {
  transform(value: unknown, space = 2): string {
    return JSON.stringify(value, null, space);
  }
}

/**
 * Formats a Date or timestamp into an ISO string or localized string.
 */
@Pipe({ name: "date", pure: true })
export class DatePipe implements PipeTransform<Date | string | number | null | undefined, string> {
  transform(
    value: Date | string | number | null | undefined,
    format: "iso" | "locale" = "iso",
  ): string {
    if (!value) return "";
    const d = new Date(value);
    if (isNaN(d.getTime())) return "";
    return format === "iso" ? d.toISOString() : d.toLocaleString();
  }
}
