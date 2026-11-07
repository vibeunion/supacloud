import { describe, expect, test } from "bun:test";
import {
  calculateAiCostMicrounits,
  extractAiTokenUsage,
  hashAiProvider,
  parseAiPricing,
} from "../../src/services/ai-usage-ledger.service";

describe("AI usage ledger helpers", () => {
  test("extracts bounded OpenAI-compatible token usage", () => {
    expect(extractAiTokenUsage({ usage: { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 } })).toEqual({
      promptTokens: 100, completionTokens: 25, totalTokens: 125,
    });
    expect(extractAiTokenUsage({ usage: { prompt_tokens: -1 } })).toBeNull();
  });

  test("calculates cost in integer microunits when both rates are configured", () => {
    expect(calculateAiCostMicrounits({ promptTokens: 1000, completionTokens: 500, totalTokens: 1500 }, 2_000_000, 4_000_000)).toBe(4_000);
    expect(calculateAiCostMicrounits(null, 1, 1)).toBeNull();
    expect(calculateAiCostMicrounits({ promptTokens: 1, completionTokens: 1 }, null, 1)).toBeNull();
  });

  test("rejects invalid pricing and never exposes provider URLs", () => {
    expect(parseAiPricing("2000000")).toBe(2_000_000);
    expect(parseAiPricing("-1")).toBeNull();
    expect(parseAiPricing("1.5")).toBeNull();
    expect(hashAiProvider("https://api.example.test")).toHaveLength(16);
    expect(hashAiProvider("https://api.example.test")).not.toContain("example");
  });
});
