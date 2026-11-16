#!/usr/bin/env node
/**
 * run-quality-gates.mjs
 * Orchestrates all quality gates. Fetches PR data once, runs all gates,
 * posts or updates a single consolidated comment via commitperclip.
 *
 * Env: GH_TOKEN, GH_REPO, PR_NUMBER, PR_AUTHOR, PR_BRANCH
 * Exit: 0 if all quality gates pass, 1 if any fail.
 */
import { fileURLToPath } from 'node:url';
import { ghFetch } from './get-bot-token.mjs';
import { fetchAllPullRequestFiles } from './fetch-pr-files.mjs';
import { checkTemplate } from './check-pr-template.mjs';
import { checkLinkedIssue } from './check-pr-linked-issue.mjs';
import { checkDedupSearch } from './check-pr-dedup-search.mjs';
import { checkTestCoverage } from './check-pr-test-coverage.mjs';
import { checkLockfile } from './check-pr-lockfile.mjs';
import { checkDependencies } from './check-pr-dependencies.mjs';
import { checkReleaseBootstrap } from './check-pr-release-bootstrap.mjs';
import { checkCoauthors, fetchAllPullRequestCommits } from './check-pr-coauthors.mjs';

const COMMENT_SIGNATURE = '— commitperclip';
const FORK_COMMENT_SIGNATURE = '<!-- paperclip-fork-quality-gates:v1 -->';

// Fixed repository and identity allowlist, never caller-supplied author names.
export function reporterSignature(mode, repo) {
  if (mode === undefined) return COMMENT_SIGNATURE;
  if (mode === 'fork-actions' && repo === 'btparks904/paperclip') return FORK_COMMENT_SIGNATURE;
  throw new Error('Unsupported quality-gate reporter or repository');
}

export function buildComment(author, failures, informational, signature = COMMENT_SIGNATURE) {
  if (failures.length === 0 && informational.length === 0) {
    return `✅ All checks passing — ready for Greptile review and maintainer approval.\n\n${signature}`;
  }

  const lines = [
    `Hey @${author}! Before this PR can be reviewed, a few things need attention:\n`,
  ];

  if (failures.length > 0) {
    lines.push('**Missing or incomplete:**');
    for (const f of failures) lines.push(`- [ ] ${f}`);
  }

  if (informational.length > 0) {
    if (failures.length > 0) lines.push('');
    lines.push('**Informational:**');
    for (const i of informational) lines.push(`- ${i}`);
  }

  lines.push(
    '\nOnce updated, push a new commit and these checks will re-run automatically.\n',
    signature
  );

  return lines.join('\n');
}

export async function findExistingComment(fetchFromGitHub, token, repo, prNumber, mode) {
  const signature = reporterSignature(mode, repo);
  for (let page = 1; ; page += 1) {
    const comments = await fetchFromGitHub(
      `/repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
      token
    );

    const existing = comments.find(
      c => (mode === 'fork-actions'
        ? c.user?.login === 'github-actions[bot]' && c.user?.type === 'Bot'
        : (c.user?.login === 'commitperclip[bot]' || c.user?.login === 'commitperclip')) &&
        typeof c.body === 'string' && (mode === 'fork-actions'
          ? c.body.trimEnd().endsWith(signature) : c.body.includes(signature))
    );
    if (existing) return existing;

    if (comments.length < 100) return null;
  }
}

async function upsertComment(token, repo, prNumber, body, existing, fetchFromGitHub) {
  if (existing) {
    await fetchFromGitHub(`/repos/${repo}/issues/comments/${existing.id}`, token, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  } else {
    await fetchFromGitHub(`/repos/${repo}/issues/${prNumber}/comments`, token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  }
}

export async function runQualityGates(env = process.env, fetchFromGitHub = ghFetch) {
  const { GH_TOKEN, GH_REPO, PR_NUMBER, PR_AUTHOR, PR_BRANCH } = env;

  if (!GH_TOKEN || !GH_REPO || !PR_NUMBER) {
    throw new Error('ERROR: GH_TOKEN, GH_REPO, PR_NUMBER env vars required');
  }

  // Sanitize inputs before use in URL construction (prevents SSRF)
  const prNumber = parseInt(PR_NUMBER, 10);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error('ERROR: PR_NUMBER must be a positive integer');
  }
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(GH_REPO)) {
    throw new Error('ERROR: GH_REPO must be in owner/repo format');
  }

  const reporterMode = env.QUALITY_GATE_REPORTER;
  const signature = reporterSignature(reporterMode, GH_REPO);

  // Fetch PR data once — gates use this, no redundant API calls
  const [pr, files] = await Promise.all([
    fetchFromGitHub(`/repos/${GH_REPO}/pulls/${prNumber}`, GH_TOKEN),
    fetchAllPullRequestFiles(fetchFromGitHub, GH_REPO, prNumber, GH_TOKEN),
  ]);

  // Separate, and allowed to fail. The co-author note is informational: it
  // cannot fail a PR by design, so it must not be able to fail the workflow by
  // accident either. Sharing the Promise.all above would let one transient
  // 5xx on this request take down every gate, including the ones that block.
  let commits = [];
  try {
    commits = await fetchAllPullRequestCommits(fetchFromGitHub, GH_REPO, prNumber, GH_TOKEN);
  } catch (error) {
    console.error(`co-author lookup skipped: ${error.message}`);
  }

  const prBody = pr.body ?? '';
  const author = PR_AUTHOR ?? pr.user.login;
  const branch = PR_BRANCH ?? pr.head.ref;

  // Run all quality gates (pure functions run sync, deps check is async)
  const prTitle = pr.title ?? '';
  const [templateResult, issueResult, dedupResult, testResult, lockfileResult, depsResult, bootstrapResult] =
    await Promise.all([
      Promise.resolve(checkTemplate(prBody)),
      Promise.resolve(checkLinkedIssue(prBody, prTitle)),
      Promise.resolve(checkDedupSearch(prBody, prTitle)),
      Promise.resolve(checkTestCoverage(files, prTitle)),
      Promise.resolve(checkLockfile(files, author, branch)),
      checkDependencies(files, GH_TOKEN, GH_REPO, prNumber, pr.base?.ref, fetchFromGitHub),
      checkReleaseBootstrap(files, GH_TOKEN, GH_REPO, prNumber, pr.base?.ref, { fetchFromGitHub }),
    ]);
  const coauthorResult = checkCoauthors(commits, author);

  const allFailures = [
    ...templateResult.failures,
    ...issueResult.failures,
    ...dedupResult.failures,
    ...testResult.failures,
    ...lockfileResult.failures,
  ];
  const informational = [
    ...(depsResult.informational ?? []),
    ...(bootstrapResult.informational ?? []),
    ...coauthorResult.informational,
  ];
  const allPassed = allFailures.length === 0;

  const commentBody = buildComment(author, allFailures, informational, signature);

  // Post comment if there are failures/informational, or update existing comment
  const existing = await findExistingComment(fetchFromGitHub, GH_TOKEN, GH_REPO, prNumber, reporterMode);
  if (allFailures.length > 0 || informational.length > 0 || existing) {
    await upsertComment(GH_TOKEN, GH_REPO, prNumber, commentBody, existing, fetchFromGitHub);
  }

  return { passed: allPassed, failures: allFailures, informational };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runQualityGates().then(result => {
    console.log(JSON.stringify(result));
    process.exit(result.passed ? 0 : 1);
  }).catch(e => { console.error(e.message); process.exit(1); });
}
