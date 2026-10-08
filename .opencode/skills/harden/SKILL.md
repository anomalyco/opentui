---
name: harden
description: >-
  Hardening pass for OpenTUI changes. Trace every changed code path. List every Zig and TypeScript
  branch arm that no test reaches, with the repo's branch-coverage tools. Find defects that survive
  an attempt to refute them. Fix them, simplify the code, and replace example tests with table,
  model, differential, and reflection tests. Keep source and test line counts flat or negative.
  Use for "harden", "find bugs in this change", "are all branches tested", "review this branch for
  defects", "improve test coverage without adding tests", "zero bug pass", or before you merge a
  large or risky branch in this repository.
---

# Harden a change

A green test suite does not prove that a change is correct. Defects hide where example tests do not
look: cross-layer seams, state-machine interleavings, hard limits, and unit boundaries.

Read `AGENTS.md` first. Load the `tigerstyle`, `code-simplification`, and `adversarial-code-review`
skills. This skill applies their rules.

## Setup

- The default scope is `git diff main...HEAD`. The user can narrow it.
- Edit in a new worktree (`git worktree add -b harden/<topic> ../ot-harden-<topic> HEAD`). Do not
  use `git stash`. All worktrees share the stash, and it holds the user's work.
- Before you edit, run the affected suites and record the pass and fail counts. Then you know which
  later failures are new. The commands are in `references/coverage-tools.md`.
- Run checks in the foreground. Do not end a turn while a background job runs.

## Step 1: measure what no test reaches

Run the branch-coverage tools on the files in scope:

```sh
cd packages/native && bun run test:branch-cov   # Zig files changed in main...HEAD
cd packages/core && bun run test:branch-cov     # TypeScript files changed in main...HEAD
```

Each tool prints `UNCOVERED file:line:col` for each branch arm, error return, switch case, or
function that no test ran. Options and limits are in `references/coverage-tools.md`.

## Step 2: trace and refute

For each changed function, list its branch arms: the uncovered arms from step 1 and the covered arms
that you read. Compare each arm with the contract: `opentui.h`, the docs, and the behavior on
`main`. Before you trace, read `references/fault-lines.md`.

A candidate is a defect only after you try to refute it and fail. Write down the attempt: is it the
same on `main`, can the public API reach it, and does the caller already reject the input? Then
reproduce the defect with a temporary probe outside the repo.

Report each defect with its location, trigger, expected and actual behavior, severity, evidence,
and regression test. Record defects that also exist on `main`, but do not fix them unless they block
a branch fix. If the scope is not clear, ask the user.

## Step 3: fix and simplify under a line budget

For each defect:

1. Write the regression test, and make sure that it fails.
2. Fix the defect, and make sure that the test passes.
3. Commit the test and the fix together (`core: ...` or `native: ...`).

Then do one of these for each arm that no test reaches, in order of preference:

1. **Delete it.** Change the code so that the state or branch does not exist.
2. **Assert it.** If an invariant makes the arm unreachable, write an `assert`.
3. **Cover it.** Extend a test of a shape in `references/test-shapes.md`. Do not add a scenario
   test.

For each unit of work, the net change in source lines must be zero or negative, and the net change
in test lines must be negative. Give a one-line reason for each source addition in its commit
message. After you edit, run step 1 again to make sure that the arms are gone from the report.

## Step 4: independent review

Give the diff to a session that did not write it. The reviewer must:

- Make sure that each regression test fails at the parent of its fix commit.
- Break the code under each new or consolidated test in two or three plausible ways, and make sure
  that a test fails each time.
- List each assertion that a consolidation removed, and each `main` API whose behavior changed.

"Merge after fixes" is the normal verdict.

## Large changes

Split a large branch into units by subsystem, with explicit file ownership. Do steps 1 and 2 for all
units in parallel, without edits. Then do steps 3 and 4 for each unit in its own worktree, and merge
each unit into an integration branch after review. The orchestrator owns one tracker file. Each
agent writes only its own unit file: scope, branch inventory, defects, planned commits, and the line
change of each commit.
