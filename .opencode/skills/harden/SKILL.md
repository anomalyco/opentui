---
name: harden
description: >-
  Hardening pass for OpenTUI changes: trace every changed code path, list every branch arm no test
  reaches (native Zig and TypeScript, with the repo's branch-coverage tools), find defects that
  survive an attempt to refute them, then fix, simplify, and replace example tests with table, model,
  differential, and reflection tests while keeping source and test line counts flat or negative.
  Use for "harden", "find bugs in this change", "are all branches tested", "review this branch for
  defects", "improve test coverage without adding tests", "check what the rebase lost", "zero bug
  pass", or before merging a large or risky branch in this repository.
---

# Harden a change

This is the method from `hardening/` (the 26-unit pass over the native render tree branch), cut down
to what one agent, or a small orchestrated set, runs on a change of any size. It found ~110 defects
in a branch whose 8,300 tests were all green, because the defects lived where example tests do not
look: cross-layer seams, state-machine interleavings, hard limits and unit boundaries, and work
silently dropped in a rebase. The method is: measure the untested branches mechanically, trace them
against the contract, refute each candidate before you call it a defect, fix with a regression test
first, and leave the code smaller than you found it.

Read `AGENTS.md` first. Load the `tigerstyle`, `code-simplification`, and `adversarial-code-review`
skills; they are the engineering rules this skill applies.

## Scope and setup

- Default scope is `git diff main...HEAD`. The user can narrow it to files or a package.
- Work in a fresh worktree for edits (`git worktree add -b harden/<topic> ../ot-harden-<topic> HEAD`),
  never with `git stash` (the stash is shared and holds the user's work).
- Baseline first: run the affected suites once and record pass/fail counts, so a later failure is
  known to be new. Commands: `references/coverage-tools.md`.
- Run checks in the foreground. Never end a turn while a background job is running; nobody is told
  when it finishes.

## Step 1: measure what no test reaches

Run the branch-coverage tools on the files in scope. Both use the engine's own coverage data, no
source rewriting:

```sh
# Native (Zig + vendored C/C++): LLVM SanitizerCoverage edge counters per basic block.
cd packages/native && bun run test:branch-cov            # files in main...HEAD
bun scripts/branch-cov.ts --files src/scene.zig          # explicit files
bun scripts/branch-cov.ts --all --filter "Scene"         # everything, only tests matching "Scene"

# Core TypeScript: JavaScriptCore block coverage through node:inspector.
cd packages/core && bun run test:branch-cov              # files in main...HEAD, whole core suite
bun scripts/branch-cov.ts --files src/NativeScene.ts --tests src/tests/renderer.native-scene*.test.ts
```

Each prints `UNCOVERED file:line:col` for every branch arm, error return, switch case, or function
that no test executed, plus `reached/total`. `if (x) return error.X;` on one line reports its untaken
arm. Details and limits are in `references/coverage-tools.md`.

## Step 2: trace and refute

For each changed function, build a branch inventory: the uncovered arms from step 1, plus the
covered ones you read. For every arm ask what the contract says (`opentui.h`, the docs, `main`'s
behavior) and whether the code does that. The recurring fault lines are in `references/fault-lines.md`;
read it before tracing, it is short.

A candidate becomes a defect only after you tried to refute it and failed. Write the refutation
attempt down ("same on `main`?", "unreachable from the public API?", "pathological input the caller
already rejects?"). Then reproduce it with a throwaway probe outside the repo (a scratch test, a
`main` worktree comparison, a bench). Report: location, trigger, expected vs actual, severity,
evidence, and the regression test that would prove it. Defects that also exist on `main` are
recorded, not fixed, unless they block a branch fix (user scope rule from the original pass; confirm
with the user if unclear).

## Step 3: fix and simplify under a line budget

Order of work for each defect: regression test first, confirm it fails, fix, confirm it passes, one
commit (`core: ...` / `native: ...`). Then, for each remaining uncovered arm, do exactly one of:

1. **Delete it.** Collapse the state or branch so it no longer exists (the paint-budget removal in
   `refactor-plan.md` is the model: an entire pause state machine gone). This is the preferred move.
2. **Assert it.** If an invariant makes the arm unreachable, say so with an `assert`, not a test.
3. **Cover it.** Extend a table, model, differential, or reflection test. Do not add a scenario test.

The budget: source lines net zero or negative, test lines net negative, per unit of work. Every
source addition needs a one-line reason in its commit. The four test shapes that earned their place
in the original pass, with examples from the repo, are in `references/test-shapes.md`.

Re-run step 1 after editing. An arm that your new table covers should disappear; an arm you deleted
should be gone from the source.

## Step 4: independent review

Hand the diff to a separate session (a subagent, or a colleague) that did not write it. It must:

- check out the parent of each fix commit and confirm the regression test fails there;
- break the code under each new or consolidated test in two or three plausible ways on a temporary
  copy and confirm a test fails each time (mutation check);
- list any assertion the consolidation dropped, and any `main` API whose behavior changed.

In the original pass this step caught a crash that had moved threads instead of disappearing, a
consolidation that lost a stale-ID check, a resize fix that added a debounce wait, and a dropped
`-Werror`. Treat "merge after fixes" as the normal verdict.

## Orchestrating a large change

For a branch too big for one session, split it into units by subsystem with explicit file
ownership, run step 1–2 for all units read-only in parallel, then steps 3–4 per unit in its own
worktree, merging each into an integration branch as it passes review. Keep one tracker file the
orchestrator owns; agents write only their own unit file. The templates, policy, and the full record
of the first run are in `hardening/` (`TRACKER.md`, `templates.md`, `OVERVIEW.md`, `units/`).
