---
name: sous-plan
description: Plan an issue (GitHub or bd) for the sous software factory (.sous). Interactive: clarifies the idea with the human, writes specs/<n>-<slug>/spec.md, files sub-issues for a feature, and commits the spec to main after an explicit GO. Use as /sous-plan [#id]; without an id it creates the issue first.
disable-model-invocation: true
---

Read `.sous/prompts/plan.md` from the repository root and follow it
end to end. It is the complete procedure; this file only starts it.

Set `ISSUE` from the skill argument: `/sous-plan 123` and `/sous-plan #123`
both mean `ISSUE=123`. With no argument, `ISSUE` is absent and the prompt's
"Inputs" section tells you to create the issue first.

Argument received: $ARGUMENTS
