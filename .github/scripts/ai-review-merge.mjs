/**
 * AI-powered PR review and auto-merge script.
 *
 * Required env vars:
 *   AI_API_KEY        - OpenAI-compatible API key (GitHub Secret)
 *   AI_API_BASE       - API base URL, e.g. https://your-proxy.com/v1 (GitHub Secret)
 *   AI_MODEL          - Model name, e.g. gpt-4o (GitHub Secret)
 *   GITHUB_TOKEN      - Auto-provided by GitHub Actions
 *   PR_NUMBER         - Pull request number
 *   GITHUB_REPOSITORY - owner/repo format
 *   GITHUB_BASE_REF   - target branch (e.g. main)
 *   GITHUB_HEAD_REF   - source branch
 */

const API_KEY  = process.env.AI_API_KEY;
const API_BASE = process.env.AI_API_BASE;
const MODEL    = process.env.AI_MODEL || 'gpt-4o';
const GH_TOKEN = process.env.GITHUB_TOKEN;
const PR_NUM   = process.env.PR_NUMBER;
const REPO     = process.env.GITHUB_REPOSITORY;
const BASE_REF = process.env.GITHUB_BASE_REF;
const HEAD_REF = process.env.GITHUB_HEAD_REF;

const GH_API = `https://api.github.com/repos/${REPO}`;

// --- GitHub API helpers ------------------------------------------------

async function ghFetch(path, options = {}) {
  const res = await fetch(`${GH_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'ai-review-bot',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status}: ${text}`);
  }
  // 204 No Content (merge)
  if (res.status === 204) return null;
  return res.json();
}

async function getDiff() {
  const res = await fetch(`${GH_API}/pulls/${PR_NUM}`, {
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: 'application/vnd.github.v3.diff',
      'User-Agent': 'ai-review-bot',
    },
  });
  if (!res.ok) throw new Error(`Failed to fetch diff: ${res.status}`);
  return res.text();
}

// --- AI review ---------------------------------------------------------

async function aiReview(diff) {
  const MAX_CHARS = 100_000;
  const truncated =
    diff.length > MAX_CHARS
      ? diff.slice(0, MAX_CHARS) + '\n... (diff truncated)'
      : diff;

  const prompt = [
    'You are a senior code reviewer. Review the following PR diff.',
    '',
    `Target branch: ${BASE_REF}`,
    `Source branch: ${HEAD_REF}`,
    '',
    '**Review Checklist:**',
    '1. Bugs & Logic Errors',
    '2. Security Issues (injection, auth bypass, data exposure)',
    '3. Performance (N+1 queries, unnecessary loops)',
    '4. Error Handling',
    '5. Code Style & Dead Code',
    '6. Breaking Changes',
    '',
    '**Output Format (Markdown):**',
    '- First line must be exactly `APPROVE` or `REQUEST_CHANGES`',
    '- Then list findings with file/line references',
    '- Keep it concise and actionable',
    '',
    '```diff',
    truncated,
    '```',
  ].join('\n');

  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 4096,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AI API ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || 'No review generated';
}

// --- Post comment & merge ----------------------------------------------

async function postComment(body) {
  await ghFetch(`/issues/${PR_NUM}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

async function mergePR() {
  await ghFetch(`/pulls/${PR_NUM}/merge`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commit_title: `Merge pull request #${PR_NUM} from ${HEAD_REF}`,
      merge_method: 'squash',
    }),
  });
}

// --- Main --------------------------------------------------------------

async function main() {
  if (!API_KEY || !API_BASE || !GH_TOKEN || !PR_NUM || !REPO) {
    console.error('Missing required environment variables.');
    process.exit(1);
  }

  console.log(`Reviewing PR #${PR_NUM} in ${REPO} (${HEAD_REF} -> ${BASE_REF})`);

  console.log('Fetching diff...');
  const diff = await getDiff();
  console.log(`Diff size: ${diff.length} chars`);

  console.log(`Calling AI model: ${MODEL}...`);
  const review = await aiReview(diff);
  console.log('Review completed.');

  const comment = `## AI Code Review (${MODEL})\n\n${review}`;
  await postComment(comment);
  console.log('Review comment posted.');

  const approved = review.trim().toUpperCase().startsWith('APPROVE');
  if (approved) {
    console.log('AI approved. Auto-merging...');
    await mergePR();
    console.log('PR merged successfully.');
  } else {
    console.log('AI requested changes. PR will not be auto-merged.');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
