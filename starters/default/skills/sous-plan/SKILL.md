---
name: sous-plan
description: Plan an issue for the sous software factory (.sous), on whatever tracker sous.yaml names. Interactive: clarifies the idea with the human, writes specs/<id>-<slug>/spec.md, brings a feature's children into the run phase's shape and files the missing ones, and commits the spec to the base branch after an explicit GO; while the issue's run is blocked it amends in that run's worktree instead, and while it is running it refuses. Rerunning it on a planned issue changes nothing. Use as /sous-plan [#id]; without an id it creates the issue first.
disable-model-invocation: true
---

Read `.sous/prompts/plan.md` from the repository root and follow it
end to end. It is the complete procedure; this file only starts it.

Set `ISSUE` from the skill argument: `/sous-plan 123` and `/sous-plan #123`
both mean `ISSUE=123`. With no argument, `ISSUE` is absent and the prompt's
"Inputs" section tells you to create the issue first.

Argument received: $ARGUMENTS
