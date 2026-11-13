import { describe, expect, test } from "bun:test";
import {
    DEFAULT_DELIVERY_OPTIMIZATION,
    mergeDeliveryOptimization,
    normalizeDeliveryOptimization,
    parseDeliveryOptimizationPatch,
} from "../../src/services/delivery-optimization";

describe("delivery optimization policy", () => {
    test("defaults to safe versioned public asset caching", () => {
        expect(normalizeDeliveryOptimization(undefined)).toEqual(DEFAULT_DELIVERY_OPTIMIZATION);
    });

    test("rejects invalid policies and disabling compression", () => {
        expect(() => parseDeliveryOptimizationPatch({ profile: "unknown" })).toThrow("field");
        expect(() => parseDeliveryOptimizationPatch({ compression: false })).toThrow("disabled");
        expect(() => parseDeliveryOptimizationPatch({ cache_ttl_seconds: -1 })).toThrow("TTL");
    });

    test("normalizes public and disabled cache modes to coherent lifetimes", () => {
        expect(normalizeDeliveryOptimization({ cache_mode: "public" })).toMatchObject({
            cache_mode: "public",
            cache_ttl_seconds: 3600,
            stale_while_revalidate_seconds: 60,
        });
        expect(normalizeDeliveryOptimization({
            cache_mode: "disabled",
            cache_ttl_seconds: 31536000,
            stale_while_revalidate_seconds: 3600,
        })).toMatchObject({
            cache_mode: "disabled",
            cache_ttl_seconds: 0,
            stale_while_revalidate_seconds: 0,
        });
    });

    test("merges an explicit public cache policy without accepting arbitrary fields", () => {
        expect(mergeDeliveryOptimization(undefined, {
            cache_mode: "public",
            cache_ttl_seconds: 600,
            stale_while_revalidate_seconds: 60,
        })).toEqual({
            compression: true,
            cache_mode: "public",
            cache_ttl_seconds: 600,
            stale_while_revalidate_seconds: 60,
        });
    });
});
