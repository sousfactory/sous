# Spec: <issue title>

- **Issue:** <issue ref>
- **Status:** <draft when /sous-plan wrote it with the human; derived when the plan step derived it from the issue>

## Problem Statement

<the problem from the user's perspective: who has it, when, what goes wrong today>

## Solution

<the solution from the user's perspective: what they can do afterwards, not how it is built>

## User Stories

1. <a long, numbered list; one observable behaviour per story, checkable from outside; the reviewer's yardstick>

## Implementation Decisions

<decisions, not file paths or code; a prototype snippet only where it encodes a decision more precisely than prose>

## Testing Decisions

<the seams the tests use and the prior art they follow; the reviewer's second yardstick; never the repository's build or test commands, the run's evals own that gate>

## Out of Scope

<what this spec deliberately leaves out>

## Assumptions

- <one per item, written by the plan step: what the issue left open, what it assumed, why; `None.` when the human decided everything in the plan session>

## Open questions

- <one per item, written by the plan step: the readings, and the one it would pick; `None.` or no list when there are none; the run stays blocked while any is listed>

## Decisions

<empty when the spec is written; implement and fix append one line per decision they make while building, with its reason, and the reviewer judges the line instead of the departure it explains>

## Further Notes

<anything the sections above have no place for; `None.` otherwise>

<!--
The shape of `specs/<issue>-<slug>/spec.md`. Copy the headings, not this
comment, and replace every `<placeholder>` with what it asks for; an
empty section keeps its heading with `None.` under it. The run hands the
whole file to every step as `ctx.spec`; the steps read the sections by
name (`steps/plan/eval.ts` reads the list items under Open questions and
Assumptions).
-->
