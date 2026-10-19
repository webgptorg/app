---
description: Pick the next unblocked task from the implementation plan and deliver it as a merged PR
---

Follow "Working on a task" in AGENTS.md exactly.

1. Read AGENTS.md, docs/plan/README.md and docs/engineering.md.
2. Pick a task: $ARGUMENTS if given, otherwise the first task from `bun run plan --next` that no open PR or remote branch already claims.
3. Read its brief in docs/plan/tasks/ and the spec sections it names.
4. Create your worktree and branch, claim the task with a draft PR, build it with tests, self-review against the acceptance criteria, mark it done, merge when CI is green, and remove the worktree.
5. If the brief is ambiguous in a way that changes behaviour, or a zero-trust rule would bend, stop and ask instead of guessing.
