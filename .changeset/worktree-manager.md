---
"@effect-x/lalph": patch
---

Add `lalph worktree list`, `lalph worktree switch`, `lalph worktree rm`, and `lalph worktree prune` so temporary git worktrees and jj workspaces can be inspected, opened with post-switch hooks, and removed outside the main task loop. Temporary execution directories now also sync shared `.lalph/config`, `.lalph/projects`, and `.lalph/hooks.yml`.
