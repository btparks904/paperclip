import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const workflow = readFileSync(new URL('../../workflows/commitperclip-review.yml', import.meta.url), 'utf8');
const fork = workflow.split('  fork-review:')[1];
test('fork job uses immutable trusted workflow revision and no persisted credentials', () => {
  assert.match(fork, /ref: \$\{\{ github.workflow_sha \}\}/);
  assert.doesNotMatch(fork, /^          ref:.*pull_request/m);
  assert.match(fork, /repository: \$\{\{ github.repository \}\}/);
  assert.match(fork, /persist-credentials: false/);
  assert.doesNotMatch(fork, /^          ref: master|^          ref:.*head|refs\/pull|npm install|pnpm|secrets\.|get-bot-token/m);
});
test('fork has bounded authority, serialization, all checks and failure propagation', () => {
  assert.match(fork, /if: github.repository == 'btparks904\/paperclip'/);
  assert.match(workflow, /if: github.repository != 'btparks904\/paperclip'/);
  assert.match(fork, /permissions:\n      contents: read\n      pull-requests: write/);
  assert.doesNotMatch(fork, /checks: write|issues: write|contents: write|continue-on-error/);
  assert.match(fork, /group: fork-quality-.*github.repository.*pull_request.number/);
  assert.match(fork, /cancel-in-progress: false/);
  assert.match(fork, /actions\/dependency-review-action@[a-f0-9]{40}/);
  assert.match(fork, /run: node .github\/scripts\/run-quality-gates.mjs/);
  assert.match(fork, /GH_TOKEN: \$\{\{ github.token \}\}/);
  assert.match(fork, /QUALITY_GATE_REPORTER: fork-actions/);
  assert.match(fork, /package-manager-cache: false/);
});
