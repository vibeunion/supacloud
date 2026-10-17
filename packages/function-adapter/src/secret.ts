import { timingSafeEqual } from "node:crypto";

/** 缓存固定密钥摘要；每次请求仅计算调用方摘要并进行原生定时安全比较。 */
export function createSecretMatcher(expected: string): (provided: string) => boolean {
  const expectedDigest = Bun.CryptoHasher.hash("sha256", expected);
  const configured = expected.length > 0;
  return (provided) => {
    const providedDigest = Bun.CryptoHasher.hash("sha256", provided);
    return timingSafeEqual(providedDigest, expectedDigest) && provided.length > 0 && configured;
  };
}
