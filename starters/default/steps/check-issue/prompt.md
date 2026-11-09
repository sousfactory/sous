# Check issue {{ctx.work.ref}} against the code

You are working in the git worktree `{{ctx.worktree}}`, forked from the
base branch for issue {{ctx.work.ref}}. Nothing has been planned or built
yet. Before anything is, find out whether the issue still holds against the
code as it is in this worktree. Nobody will answer questions during this
step: decide, and show the evidence for it.

## The issue, as filed

{{issue}}

## What to check

1. **The defect.** Does what the issue describes as broken still happen in
   this code? It may have been fixed on the base branch since the issue was
   filed.
2. **The names.** Does each file, symbol, test or fixture the issue names
   exist, and does it say what the issue says it does?
3. **The claims.** Is each "broken", "missing" or "there is no X" claim
   true? Look for the X before you believe it is absent.
4. **The behaviour.** Where the issue claims a behaviour, reproduce it: run
   the narrowest command that shows it (one test, one script, one call),
   never the full test suite.

## The verdict

Exactly one of:

- `holds`: the issue stands against the code. Also when part of it is
  false but the defect or the missing behaviour is real (see below).
- `fixed`: the defect is gone from the code; there is nothing left to do.
- `false-premise`: the issue rests on a claim the code contradicts, and
  without that claim there is nothing left to do.
- `unclear`: the check could not settle it. The run goes on; prefer this
  to `fixed` or `false-premise` whenever the evidence is not conclusive.

The evidence is every command you ran for the verdict, each with the
relevant part of its result, verbatim. A verdict is something the human can
check by running the same commands, never an assertion. A `fixed` or
`false-premise` verdict without evidence fails this step.

## Partly false, defect real

When the defect is real but some of what the issue says is not (a renamed
file, a symbol that moved, a claim that is half true), the verdict is
`holds`, and the divergence is recorded so the later steps build and review
against what the code shows and know why. One line per divergence: what the
issue claims, what the code shows instead, and why the defect is real
anyway, written like a line of a commit body.

- Always list each line in `divergence` in your output; the later steps
  get it from there.
- When `{{ctx.specDir}}/spec.md` exists in the worktree, also append each
  line to its `## Decisions` section (create the section at the end of the
  file when there is none). Nothing else in the folder changes.
- Otherwise, write nothing under `{{ctx.specDir}}/`: the step that writes
  the spec, or the one that builds, takes the lines from your output.
  Never create the spec file.

## What you may and may not do

- Read-only on the code: no change to code, tests, fixtures or any file
  outside the `## Decisions` lines above. Remove anything a command you ran
  left behind.
- Do not touch the issue tracker: no comment, no label, no closing. A run
  never closes an issue; the human does, on your evidence.
- Commit the `## Decisions` lines, if you wrote any, on the current branch
  with the subject `spec({{ctx.work.ref}}): what the code shows against the
  issue`. Nothing else is staged. Never check out, rebase onto or merge
  another branch; never push; never create branches.
- The working tree is clean when you answer.

Report in `output` the verdict, the evidence, and every divergence line.
