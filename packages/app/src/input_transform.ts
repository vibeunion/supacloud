/**
 * Angular 16+ input transforms for parameter and attribute coercion.
 * Directly modeled after Angular's booleanAttribute and numberAttribute.
 */

/**
 * Transforms an incoming value to a boolean following Angular booleanAttribute semantics:
 * - boolean values are preserved
 * - empty strings ('') and 'true' (or any truthy string except 'false') are coerced to true
 * - 'false', false, null, and undefined are coerced to false
 */
export function booleanAttribute(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return value !== "false";
  }
  return Boolean(value);
}

/**
 * Transforms an incoming value to a number following Angular numberAttribute semantics:
 * - number values are preserved (unless NaN)
 * - valid numeric strings are parsed with parseFloat
 * - invalid or non-numeric values fall back to fallbackValue (defaults to NaN)
 */
export function numberAttribute(value: unknown, fallbackValue = NaN): number {
  const isNumber = typeof value === "number";
  const isString = typeof value === "string";
  if (!isNumber && !isString) {
    return fallbackValue;
  }
  const parsed = isNumber ? value : parseFloat(value as string);
  return isNaN(parsed) ? fallbackValue : parsed;
}
