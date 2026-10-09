# Vendored skills

Every folder here except `sous-plan/` is copied **verbatim** from Matt Pocock's
skills repo (<https://github.com/mattpocock/skills>, `skills/engineering/*` and
`skills/productivity/grilling`), so the factory has a pinned, offline-stable copy.

- License: MIT, Copyright (c) 2026 Matt Pocock (the upstream `LICENSE`).
- Source commit: `ed37663cc5fbef691ddfecd080dff42f7e7e350d`
- Vendored: 2026-07-26

| Skill | Used by |
| --- | --- |
| `to-spec`, `grill-with-docs` (+ `grilling`, `domain-modeling`), `to-tickets` | `/sous-plan` (`prompts/plan.md`) |
| `implement` (+ `tdd`) | the `implement` step |
| `code-review` | the `review` step |
| `resolving-merge-conflicts` | the `sync-resolve` step |

The factory does not run `/setup-matt-pocock-skills`: the step prompts supply
the context those skills expect, and point at the copies under `skills/`
through `{{ctx.skillsDir}}`. Do not hand-edit the vendored files, so a diff
against upstream stays clean; re-vendor by copying again.

`sous-plan/` is sous's own skill, which `sous init` installs into the
repository's `.claude/skills/`.
