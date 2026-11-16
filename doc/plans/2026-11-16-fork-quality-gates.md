# Fork quality-gate authentication

Local maintenance proposal, not activated. Based on verified fork master
`cf0ab4f7f4356246c769427a031537d3468de07d`. Only the reviewed gate fix is
ported; no Mailroom resolver, harness, or PR15 workflow changes are included.

## Scope

For `btparks904/paperclip` only, use the ephemeral repository GITHUB_TOKEN,
with contents read and pull-requests write. Retain Dependency Review and every
existing contribution gate. Other repositories keep the original commitperclip
job, token and reporting behavior. No new secrets or installed dependencies.

The fork job checks out the exact `github.workflow_sha` in the event repository,
not mutable master, a different PR target revision, or PR head/merge code. PR metadata and manifest
content are data, not executed code. Dependency Review still compares event
base/head SHAs. Check failures and API failures fail the job. Dependabot retains
the existing exemption from contribution gates, not from Dependency Review.

Fork comments use a distinct end marker and require github-actions[bot] with
Bot type. No arbitrary reporter-login override is accepted. The original
commitperclip comments are not rewritten. Per-repository/PR concurrency serializes these jobs to prevent overlapping
comment creation. It does not guarantee execution, ordering, or exact-head
reporting: GitHub may replace pending runs, and the runner reads current PR
metadata when it executes. The marker separates this
report from unrelated Actions comments, not from a malicious trusted workflow
with the same repository write authority.

## Bootstrap and authorization

`pull_request_target` uses a trusted workflow rather than the PR-head workflow.
The fork default branch is `master`; its workflow source and the non-default
patched PR target must not be assumed identical. Both workflow and reporter
must land together in the trusted workflow source selected by GitHub under
separate owner approval. Checkout uses that run's `github.workflow_sha`, so
scripts cannot come from a different target branch missing reporter support.
A PR carrying the fix cannot prove activation, and rerunning an old event is
not proof that GitHub selected the new workflow. Verify a new event's workflow
SHA and checkout SHA before claiming activation. Do not fetch or
execute this PR's proposed script with a privileged token to bypass bootstrap.
This proposal does not authorize push, merge, settings changes or activation.

This isolated maintenance branch targets the trusted default branch `master`,
not the patched Mailroom branch. Publishing and landing it require separate
owner approval. No changes are made to either trusted branch locally. Existing
main PR workflow pins are unchanged. After approved landing, verify the actual
workflow SHA on a fresh PR event before claiming the fork gate is operational.

## Verification

Synthetic tests cover reporter allowlisting, human/other-bot spoof rejection,
comment pagination and stable reuse, API-error propagation, trusted checkout,
permissions, concurrency and fail-closed workflow structure. Existing quality
script tests remain required. No live posting/API execution is performed by
these tests. Full application qualification and live workflow execution are
not claimed; production code and dependencies are unchanged.
