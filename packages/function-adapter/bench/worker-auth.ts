import { createSecretMatcher } from "../src/secret";

const secret = "worker-secret-012345678901234567890123";
const candidates = [secret, "x".repeat(secret.length)];
const iterations = 30_000;
const rounds = 5;

// 保留优化前的实现，比较范围仅为认证，不包含 HTTP、网络或业务执行。
async function webCryptoMatches(provided: string, expected: string): Promise<boolean> {
  const digest = async (value: string) => new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  const [providedDigest, expectedDigest] = await Promise.all([
    digest(provided),
    digest(expected),
  ]);
  let difference = 0;
  for (let index = 0; index < expectedDigest.length; index += 1) {
    difference |= providedDigest[index] ^ expectedDigest[index];
  }
  return difference === 0 && provided.length > 0 && expected.length > 0;
}

async function measureWebCrypto(): Promise<number> {
  let matched = 0;
  const start = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    if (await webCryptoMatches(candidates[index % 2], secret)) matched += 1;
  }
  const elapsed = performance.now() - start;
  if (matched !== iterations / 2) throw new Error("Web Crypto benchmark result mismatch");
  return elapsed;
}

function measureNative(): number {
  const matches = createSecretMatcher(secret);
  let matched = 0;
  const start = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    if (matches(candidates[index % 2])) matched += 1;
  }
  const elapsed = performance.now() - start;
  if (matched !== iterations / 2) throw new Error("Native benchmark result mismatch");
  return elapsed;
}

const warmMatcher = createSecretMatcher(secret);
for (let index = 0; index < 2_000; index += 1) {
  await webCryptoMatches(candidates[index % 2], secret);
  warmMatcher(candidates[index % 2]);
}

const webCryptoMs: number[] = [];
const nativeMs: number[] = [];
for (let round = 0; round < rounds; round += 1) {
  // 交替顺序，减少固定执行顺序对本地测量的影响。
  if (round % 2 === 0) {
    webCryptoMs.push(await measureWebCrypto());
    nativeMs.push(measureNative());
  } else {
    nativeMs.push(measureNative());
    webCryptoMs.push(await measureWebCrypto());
  }
}

function median(values: number[]): number {
  return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
}

console.log(JSON.stringify({
  bun: Bun.version,
  scope: "authentication only; no HTTP, network or application work",
  iterations,
  rounds,
  webCryptoMs,
  nativeMs,
  medianSpeedup: median(webCryptoMs) / median(nativeMs),
}, null, 2));
