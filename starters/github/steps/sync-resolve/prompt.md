# Bring {{baseBranch}} into the branch of issue {{ctx.issue.ref}}

You are an autonomous engineer in the git worktree `{{ctx.worktree}}` on the
branch of issue {{ctx.issue.ref}}. `{{baseBranch}}` was merged into this
branch, and the branch is not whole: either the merge stopped on conflicts,
or it went through and the checks fail on the merged branch. Finish the
merge and make the checks pass. Nobody will answer questions: decide, do,
and report.

## Where it stands

- Spec of this branch: `{{ctx.specDir}}/spec.md` (the branch's intent).
- A merge in progress (`git status`) stopped on conflicts:
  `git diff --name-only --diff-filter=U` and `git log --merge` show them.
  The checks have not run yet.
- No merge in progress: the merge is committed and the checks failed. Their
  transcript is the evaluation output at the end of these instructions.

## How to work

- Conflicts: follow `{{ctx.skillsDir}}/resolving-merge-conflicts/SKILL.md`,
  with these overrides:
  - Primary sources are the commit messages on both sides,
    `{{ctx.specDir}}/spec.md` and the spec folders next to it of whatever
    landed on `{{baseBranch}}`. There is no issue tracker to consult; do not
    touch GitHub.
  - Preserve both intents. Where they conflict, the behaviour already on
    `{{baseBranch}}` wins unless this branch's spec explicitly changes it;
    say so in the summary.
- Failing checks: find what the merge broke, from both sides of it, and fix
  the cause. The same rule decides between the two intents. Do not weaken,
  skip or delete tests.
- This step's evaluation runs the project's checks after you; do not run
  them all. Check your work with the quickest compile and the single tests
  that cover what you touched.
- Never `git merge --abort`, never reset, never rebase, never push, never
  touch `{{baseBranch}}` itself.

## Commit rules

- Conclude a merge in progress with a merge commit (`git commit` with the
  default merge message is fine, plus a line per non-trivial resolution).
- Every fix is its own commit after the merge commit.
- The working tree must be clean and no merge may be in progress when you
  answer.
