export const DELIVERY_CACHE_MODES = ["disabled", "public_versioned", "public"] as const;
export type DeliveryCacheMode = (typeof DELIVERY_CACHE_MODES)[number];

export interface DeliveryOptimizationConfig {
    compression: true;
    cache_mode: DeliveryCacheMode;
    cache_ttl_seconds: number;
    stale_while_revalidate_seconds: number;
}

export const DEFAULT_DELIVERY_OPTIMIZATION: DeliveryOptimizationConfig = {
    compression: true,
    cache_mode: "public_versioned",
    cache_ttl_seconds: 31_536_000,
    stale_while_revalidate_seconds: 3_600,
};

const MAX_CACHE_TTL_SECONDS = 31_536_000;
const MAX_STALE_WHILE_REVALIDATE_SECONDS = 86_400;
const DEFAULT_PUBLIC_CACHE_TTL_SECONDS = 3_600;
const DEFAULT_PUBLIC_STALE_WHILE_REVALIDATE_SECONDS = 60;

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function cacheMode(value: unknown): DeliveryCacheMode | undefined {
    return typeof value === "string" && DELIVERY_CACHE_MODES.includes(value as DeliveryCacheMode)
        ? value as DeliveryCacheMode
        : undefined;
}

function boundedSeconds(value: unknown, max: number): number | undefined {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max
        ? value
        : undefined;
}

export function normalizeDeliveryOptimization(value: unknown): DeliveryOptimizationConfig {
    const input = record(value);
    const selectedCacheMode = cacheMode(input["cache_mode"]) ?? DEFAULT_DELIVERY_OPTIMIZATION.cache_mode;
    const ttl = selectedCacheMode === "disabled"
        ? 0
        : boundedSeconds(input["cache_ttl_seconds"], MAX_CACHE_TTL_SECONDS)
            ?? (selectedCacheMode === "public_versioned"
                ? DEFAULT_DELIVERY_OPTIMIZATION.cache_ttl_seconds
                : DEFAULT_PUBLIC_CACHE_TTL_SECONDS);
    const stale = selectedCacheMode === "disabled"
        ? 0
        : boundedSeconds(input["stale_while_revalidate_seconds"], MAX_STALE_WHILE_REVALIDATE_SECONDS)
            ?? (selectedCacheMode === "public_versioned"
                ? DEFAULT_DELIVERY_OPTIMIZATION.stale_while_revalidate_seconds
                : DEFAULT_PUBLIC_STALE_WHILE_REVALIDATE_SECONDS);

    return {
        compression: true,
        cache_mode: selectedCacheMode,
        cache_ttl_seconds: ttl,
        stale_while_revalidate_seconds: stale,
    };
}

export function parseDeliveryOptimizationPatch(value: unknown): Partial<DeliveryOptimizationConfig> {
    const input = record(value);
    const allowed = new Set([
        "compression", "cache_mode", "cache_ttl_seconds",
        "stale_while_revalidate_seconds",
    ]);
    if (Object.keys(input).some((key) => !allowed.has(key))) {
        throw new Error("Invalid delivery optimization field");
    }
    if (input["compression"] !== undefined && input["compression"] !== true) {
        throw new Error("Delivery compression cannot be disabled");
    }
    const selectedCacheMode = input["cache_mode"] === undefined ? undefined : cacheMode(input["cache_mode"]);
    if (input["cache_mode"] !== undefined && selectedCacheMode === undefined) {
        throw new Error("Invalid delivery cache mode");
    }
    const ttl = input["cache_ttl_seconds"] === undefined
        ? undefined
        : boundedSeconds(input["cache_ttl_seconds"], MAX_CACHE_TTL_SECONDS);
    if (input["cache_ttl_seconds"] !== undefined && ttl === undefined) {
        throw new Error("Invalid delivery cache TTL");
    }
    const stale = input["stale_while_revalidate_seconds"] === undefined
        ? undefined
        : boundedSeconds(input["stale_while_revalidate_seconds"], MAX_STALE_WHILE_REVALIDATE_SECONDS);
    if (input["stale_while_revalidate_seconds"] !== undefined && stale === undefined) {
        throw new Error("Invalid stale-while-revalidate duration");
    }
    return {
        compression: true,
        ...(selectedCacheMode === undefined ? {} : { cache_mode: selectedCacheMode }),
        ...(ttl === undefined ? {} : { cache_ttl_seconds: ttl }),
        ...(stale === undefined ? {} : { stale_while_revalidate_seconds: stale }),
    };
}

export function mergeDeliveryOptimization(
    current: unknown,
    patch: unknown,
): DeliveryOptimizationConfig {
    return normalizeDeliveryOptimization({
        ...normalizeDeliveryOptimization(current),
        ...parseDeliveryOptimizationPatch(patch),
    });
}
