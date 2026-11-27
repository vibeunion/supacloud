import { createHmac, timingSafeEqual } from "node:crypto";
import type { ImgproxyConfig } from "./config";

export function signPath(
    path: string,
    key: Uint8Array,
    salt: Uint8Array,
    signatureSize = 32,
): string {
    const digest = createHmac("sha256", key).update(salt).update(path).digest();
    return Buffer.from(digest.subarray(0, Math.min(signatureSize, digest.byteLength))).toString("base64url");
}

export function verifySignature(
    signature: string,
    path: string,
    config: ImgproxyConfig,
): boolean {
    if (config.keys.length === 0) return true;
    if (config.trustedSignatures.has(signature)) return true;

    let provided: Buffer;
    try {
        provided = Buffer.from(signature, "base64url");
    } catch {
        return false;
    }
    if (provided.byteLength === 0) return false;

    for (let index = 0; index < config.keys.length; index += 1) {
        const key = config.keys[index];
        const salt = config.salts[index];
        const digest = createHmac("sha256", key).update(salt).update(path).digest();
        const expected = digest.subarray(0, Math.min(config.signatureSize, digest.byteLength));
        if (expected.byteLength === provided.byteLength && timingSafeEqual(expected, provided)) {
            return true;
        }
    }
    return false;
}
