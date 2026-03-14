import { Command } from "effect/unstable/cli"
import { commandWorktreeList } from "./worktree/list.ts"
import { commandWorktreePrune } from "./worktree/prune.ts"
import { commandWorktreeRm } from "./worktree/rm.ts"
import { commandWorktreeSwitch } from "./worktree/switch.ts"

const subcommands = Command.withSubcommands([
  commandWorktreeList,
  commandWorktreeSwitch,
  commandWorktreeRm,
  commandWorktreePrune,
])

export const commandWorktree = Command.make("worktree").pipe(
  Command.withAlias("wt"),
  Command.withDescription(
    "Manage repository worktrees and jj workspaces. Use 'list' to inspect them, 'switch' to open one with post-switch hooks, 'rm' to remove one, and 'prune' to forget missing entries.",
  ),
  subcommands,
)
