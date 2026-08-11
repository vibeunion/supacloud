const PROJECT_REF_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function projectRefPathSegment(ref: unknown, operation: string): string {
    if (typeof ref !== "string" || !PROJECT_REF_PATTERN.test(ref)) {
        throw new Error(`'ref' is invalid for ${operation}`);
    }
    return encodeURIComponent(ref);
}
