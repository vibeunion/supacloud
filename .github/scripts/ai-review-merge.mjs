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

import { readFile } from 'node:fs/promises';

const API_KEY  = process.env.AI_API_KEY;
const API_BASE = process.env.AI_API_BASE;
const MODEL    = process.env.AI_MODEL || 'gpt-4o';
const GH_TOKEN = process.env.GITHUB_TOKEN;
const PR_NUM   = process.env.PR_NUMBER;
const REPO     = process.env.GITHUB_REPOSITORY;
const BASE_REF = process.env.GITHUB_BASE_REF;
const HEAD_REF = process.env.GITHUB_HEAD_REF;

const GH_API = `https://api.github.com/repos/${REPO}`;
const MAX_DIFF_CHARS = 100_000;
const MAX_CONTEXT_FILE_CHARS = 8_000;

const CONTEXT_FILES = [
  '.github/ai-review-context.md',
  'AGENTS.md',
  'tasks.md',
  'progress.md',
  '.mailbox/README.md',
  '.agents/automations/task-contract.md',
  '.agents/workflows/pr-review-merge.md',
  '.agents/workflows/task-automation.md',
  '.agents/workflows/deploy-verify.md',
];

const BASELINE_SKILLS = [
  ['agent-team-automation', 'project automation, Task Contract, ledger, progress/mailbox, and review workflow rules'],
  ['provider-adapter', 'GitHub PR state, CI visibility, merge safety, and provider consistency'],
  ['typescript', 'TypeScript changes and Bun-compatible module/type safety'],
  ['bun-cli-cross-platform', 'Bun scripts, GitHub Actions scripts, build/deploy commands, and cross-platform behavior'],
];

const PATH_SKILL_RULES = [
  {
    skill: 'elysiajs',
    reason: 'management API or edge-runtime Elysia route/runtime changes',
    matches: (file) => file.startsWith('packages/management-api/') || file.startsWith('packages/edge-runtime/'),
  },
  {
    skill: 'svelte-code-writer',
    reason: 'Svelte 5 component/module syntax must be checked with Svelte tooling',
    matches: (file) => file.startsWith('packages/web-console/') && /\.(svelte|svelte\.[jt]s)$/.test(file),
  },
  {
    skill: 'svelte-core-bestpractices',
    reason: 'web-console Svelte 5 reactivity, props, event, and component best practices',
    matches: (file) => file.startsWith('packages/web-console/src/'),
  },
  {
    skill: 'tailwind-v4',
    reason: 'web-console Tailwind v4 styling/configuration changes',
    matches: (file) => file.startsWith('packages/web-console/') && (
      file.endsWith('.svelte') ||
      file.endsWith('.css') ||
      file.includes('tailwind.config') ||
      file.includes('postcss.config') ||
      file.includes('vite.config')
    ),
  },
  {
    skill: 'shadcn',
    reason: 'shadcn/ui component or registry changes',
    matches: (file) => file.endsWith('components.json') || file.includes('/components/ui/') || file.includes('/registry/'),
  },
  {
    skill: 'agent-team-automation',
    reason: 'agent-team workflow, ledger, progress, mailbox, or CI automation changes',
    matches: (file) => (
      file.startsWith('.agents/') ||
      file.startsWith('.github/workflows/') ||
      file.startsWith('.github/scripts/') ||
      file === 'tasks.md' ||
      file === 'progress.md' ||
      file.startsWith('.mailbox/')
    ),
  },
  {
    skill: 'provider-adapter',
    reason: 'provider-facing PR/CI workflow or external state mapping changes',
    matches: (file) => (
      file.startsWith('.github/') ||
      file.startsWith('.agents/') ||
      file.includes('provider') ||
      file.includes('adapter')
    ),
  },
];

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

async function getChangedFiles() {
  const files = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await ghFetch(`/pulls/${PR_NUM}/files?per_page=100&page=${page}`);
    files.push(...batch);
    if (batch.length < 100) break;
  }
  return files;
}

function addSkill(skills, skill, reason) {
  if (!skills.has(skill)) skills.set(skill, new Set());
  skills.get(skill).add(reason);
}

function inferRequiredSkills(changedFiles) {
  const skills = new Map();
  for (const [skill, reason] of BASELINE_SKILLS) {
    addSkill(skills, skill, reason);
  }

  for (const file of changedFiles) {
    const filename = file.filename || '';
    for (const rule of PATH_SKILL_RULES) {
      if (rule.matches(filename)) {
        addSkill(skills, rule.skill, rule.reason);
      }
    }
  }

  return [...skills.entries()]
    .map(([skill, reasons]) => `- \`${skill}\`: ${[...reasons].join('; ')}`)
    .join('\n');
}

function formatChangedFiles(changedFiles) {
  if (!changedFiles.length) return '(No changed files reported by GitHub API)';
  return changedFiles
    .map((file) => {
      const stats = `+${file.additions ?? 0}/-${file.deletions ?? 0}`;
      return `- ${file.status || 'modified'} ${file.filename} (${stats})`;
    })
    .join('\n');
}

async function readContextFile(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const trimmed = text.length > MAX_CONTEXT_FILE_CHARS
      ? `${text.slice(0, MAX_CONTEXT_FILE_CHARS)}\n... (context truncated)`
      : text;
    return `## ${filePath}\n\n${trimmed}`;
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return `## ${filePath}\n\n(Not present in checkout)`;
    }
    return `## ${filePath}\n\n(Unable to read: ${err.message})`;
  }
}

async function loadProjectContext() {
  const sections = await Promise.all(CONTEXT_FILES.map(readContextFile));
  return sections.join('\n\n---\n\n');
}

// --- AI review ---------------------------------------------------------

async function aiReview(diff, changedFiles, projectContext) {
  const truncated =
    diff.length > MAX_DIFF_CHARS
      ? diff.slice(0, MAX_DIFF_CHARS) + '\n... (diff truncated)'
      : diff;
  const requiredSkills = inferRequiredSkills(changedFiles);
  const changedFilesText = formatChangedFiles(changedFiles);

  const prompt = [
    'You are a senior code reviewer for the SupaCloud repository.',
    'You must follow the repository project rules, Task Contract requirements, and applicable skills. Do not perform a generic-only review.',
    'Respond in Simplified Chinese, except keep file paths, identifiers, and the first decision line unchanged.',
    '',
    `Target branch: ${BASE_REF}`,
    `Source branch: ${HEAD_REF}`,
    '',
    '**Changed Files:**',
    changedFilesText,
    '',
    '**Applicable Skills Inferred From This PR:**',
    requiredSkills,
    '',
    '**Project Context To Enforce:**',
    projectContext,
    '',
    '**Mandatory Review Checklist:**',
    '1. Confirm the applicable skills and whether the diff follows each one.',
    '2. Check Task Contract goal, non-goals, acceptance criteria, verification plan, risk, and rollback evidence.',
    '3. Check bugs, logic errors, type safety, error handling, security, auth boundaries, data exposure, and breaking changes.',
    '4. Check CI/provider behavior, permissions, merge safety, and whether review/merge automation obeys project workflow rules.',
    '5. Check performance, resource usage, production stability, and deploy/rollback implications when relevant.',
    '6. Check code style, dead code, unnecessary scope expansion, and missing tests or verification.',
    '',
    '**Decision Policy:**',
    '- Use `REQUEST_CHANGES` if required skills are missing, ignored, or contradicted by the diff.',
    '- Use `REQUEST_CHANGES` if Task Contract or verification evidence is incomplete for non-trivial automation, auth, permission, migration, CI, or production deployment changes.',
    '- Use `REQUEST_CHANGES` if checks are failing, pending without a safe wait/recheck path, or provider visibility is unclear.',
    '- Use `APPROVE` only when the diff is narrow, project rules are satisfied, relevant skills are followed, and verification evidence is sufficient.',
    '',
    '**Output Format (Markdown):**',
    '- First line must be exactly `APPROVE` or `REQUEST_CHANGES`.',
    '- Then include `Required Skills` with the applicable skill names and pass/fail notes.',
    '- Then list findings with file/line references.',
    '- Keep it concise and actionable.',
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

  console.log('Fetching changed files...');
  const changedFiles = await getChangedFiles();
  console.log(`Changed files: ${changedFiles.length}`);

  console.log('Loading project review context...');
  const projectContext = await loadProjectContext();

  console.log('Fetching diff...');
  const diff = await getDiff();
  console.log(`Diff size: ${diff.length} chars`);

  console.log(`Calling AI model: ${MODEL}...`);
  const review = await aiReview(diff, changedFiles, projectContext);
  console.log('Review completed.');

  const comment = `## AI Code Review (${MODEL})\n\n${review}`;
  await postComment(comment);
  console.log('Review comment posted.');

  const firstLine = review.trim().split(/\r?\n/, 1)[0]?.trim().toUpperCase();
  const approved = firstLine === 'APPROVE';
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
