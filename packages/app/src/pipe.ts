/**
 * Angular-style Pipes & Transformation Suite (@angular/core).
 * Enables pure and declarative data transformations for route responses,
 * payloads, and presentation layers.
 */

export interface PipeTransform<T = any, R = any> {
  transform(value: T, ...args: any[]): R;
}

export interface PipeMetadata {
  name: string;
  pure?: boolean;
  standalone?: boolean;
}

const PIPE_METADATA_KEY = Symbol.for("supacloud.pipe");

export function Pipe(options: PipeMetadata): ClassDecorator {
  return (target: any) => {
    const meta: PipeMetadata = {
      pure: true,
      standalone: true,
      ...options,
    };
    if (typeof Reflect !== "undefined" && typeof (Reflect as any).defineMetadata === "function") {
      (Reflect as any).defineMetadata(PIPE_METADATA_KEY, meta, target);
    }
    target[PIPE_METADATA_KEY] = meta;
  };
}

export function getPipeMetadata(target: any): PipeMetadata | undefined {
  if (!target) return undefined;
  if (typeof Reflect !== "undefined" && typeof (Reflect as any).getMetadata === "function") {
    const meta = (Reflect as any).getMetadata(PIPE_METADATA_KEY, target);
    if (meta) return meta;
  }
  return target[PIPE_METADATA_KEY];
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
