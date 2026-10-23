# Derive the spec for issue {{ctx.issue.ref}}

You are working in the git worktree `{{ctx.worktree}}` on the branch of
issue {{ctx.issue.ref}}. The branch has no spec, so the issue is all the
later steps would build and review against. Write the spec they will use
instead: `{{ctx.specDir}}/spec.md`. Nobody will answer questions during
this step; what you cannot decide alone you write down and stop.

## The issue, as filed

{{issue}}

## What you may and may not do

- **Derive, do not extend.** Every sentence in the spec traces to the
  issue, to a documented rule of this repository, or to the code as it is.
  Nothing the issue did not ask for gets in, however sensible.
- **Decide by default and record it.** Where the issue leaves a choice
  open, take the simplest reading that fits the issue, the repository's
  rules and the code, and list that choice under `## Assumptions`. The
  implement step would make it silently otherwise; here it is visible.
- **Leave a question open only when an assumption would be wrong to make
  alone.** Two tests, either one is enough: the readings differ in
  observable behaviour, so the acceptance criteria would differ; or the
  choice is expensive to reverse (a data model, a public interface, a
  migration, anything the repository's rules record as a decision). Such a
  question goes under `## Open questions`, with the readings you see and
  the one you would pick. Everything else is an assumption.
- A one-line issue that cannot be built without guessing its behaviour is
  a list of open questions, not a spec.
- Read-only outside the spec folder: no code, no tests, no other file.
  Do not touch the issue tracker.

## How to work

1. Read the issue, the repository's documented standards (the files
   `CLAUDE.md` or `AGENTS.md` point at, every decision record under
   `docs/adr/`) and the code the issue touches. Cross-check terms and seams
   against the code as `{{ctx.skillsDir}}/domain-modeling/SKILL.md`
   describes; do not ask its questions, answer them from the code or record
   them.
2. Find the questions the way `{{ctx.skillsDir}}/grilling/SKILL.md`
   finds them, write-only: every place where two readings of the issue lead
   to different work is a candidate; apply the two tests above to sort each
   into an assumption or an open question.
3. Write the spec as `{{ctx.skillsDir}}/to-spec/SKILL.md` writes one:
   synthesis, no interview.

## The file

`{{ctx.specDir}}/spec.md`, in the shape of `{{ctx.templatesDir}}/spec.md`,
which says what every section holds and who writes it: the headings in
that order, every `<placeholder>` replaced with what it asks for, none of
the template's comments, with `- **Issue:** {{ctx.issue.ref}}` and
`- **Status:** derived`. Keep it short: a derived spec is a restatement
with structure, not a design document.

## Commit rules

- Commit `{{ctx.specDir}}/spec.md` on the current branch, with the subject
  `spec({{ctx.issue.ref}}): derived from the issue`. Nothing else is
  staged. Never check out, rebase onto or merge another branch; never push;
  never create branches.
- The working tree is clean when you answer.

Report in `output` how many assumptions and how many open questions the
file lists.
