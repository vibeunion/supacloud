export function requireValue<T>(value: T | null | undefined): T {
    if (value === undefined || value === null) {
        throw new Error("Expected test value to be present");
    }
    return value;
}
