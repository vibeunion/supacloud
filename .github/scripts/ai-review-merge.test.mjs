import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  AiApiError,
  formatAiUnavailableComment,
  isAiProviderUnavailableError,
  summarizeAiProviderError,
} from './ai-review-merge.mjs';

describe('AI review provider failure handling', () => {
  test('classifies provider auth failures hidden behind HTTP 500 as unavailable', () => {
    const error = new AiApiError(
      500,
      '{"error":{"message":"xunfei response error: AppIdNoAuthError (request id: 2026062214080095251574710887624)"}}',
    );

    assert.equal(isAiProviderUnavailableError(error), true);
    assert.match(summarizeAiProviderError(error), /HTTP 500/);
    assert.match(summarizeAiProviderError(error), /AppIdNoAuthError/);
  });

  test('classifies rate limits and network failures as unavailable', () => {
    assert.equal(isAiProviderUnavailableError(new AiApiError(429, 'rate limit exceeded')), true);
    assert.equal(isAiProviderUnavailableError(new TypeError('fetch failed: ECONNRESET')), true);
  });

  test('does not hide local script bugs as provider downtime', () => {
    assert.equal(isAiProviderUnavailableError(new Error('Cannot read properties of undefined')), false);
    assert.equal(isAiProviderUnavailableError(new AiApiError(400, 'invalid JSON request body')), false);
  });

  test('formats a neutral notice that disables auto-merge without leaking secrets', () => {
    const comment = formatAiUnavailableComment({
      model: 'qwen-review',
      sha: 'a854c3d6f2503859531be54b2b1cbdbb9d86dde3',
      error: new AiApiError(403, 'Authorization: Bearer sk-secret api_key=abc123 Forbidden'),
      ciStatus: { allCompleted: true, allPassed: true },
    });

    assert.match(comment, /^## AI Review Unavailable \(qwen-review\) — a854c3d/m);
    assert.match(comment, /关闭自动合并/);
    assert.match(comment, /当前业务 CI 已完成并通过/);
    assert.doesNotMatch(comment, /sk-secret/);
    assert.doesNotMatch(comment, /abc123/);
  });
});
