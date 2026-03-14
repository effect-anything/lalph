import { Effect } from "effect"
import { Command } from "effect/unstable/cli"
import {
  formatRepositoryWorkspace,
  getCurrentRepository,
  pruneRepositoryWorkspaces,
} from "../../shared/vcs.ts"

export const commandWorktreePrune = Command.make("prune").pipe(
  Command.withDescription(
    "Remove stale git worktrees or jj workspaces whose directories no longer exist.",
  ),
  Command.withHandler(
    Effect.fnUntraced(function* () {
      const repository = yield* getCurrentRepository
      const removed = yield* pruneRepositoryWorkspaces(repository).pipe(
        Effect.catchTags({
          RepositoryWorkspaceIsCurrent: (error) => {
            console.log(error.message)
            return Effect.succeed([])
          },
          RepositoryWorkspaceRemoveError: (error) => {
            console.log(error.message)
            return Effect.succeed([])
          },
        }),
      )

      if (removed.length === 0) {
        console.log(
          repository.kind === "git"
            ? "No stale worktrees found."
            : "No stale workspaces found.",
        )
        return
      }

      console.log(
        `Removed ${removed.length} stale entr${removed.length === 1 ? "y" : "ies"}:`,
      )
      for (const workspace of removed) {
        console.log(formatRepositoryWorkspace(workspace))
      }
    }),
  ),
)
