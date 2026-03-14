import { Effect } from "effect"
import { Command } from "effect/unstable/cli"
import {
  formatRepositoryWorkspace,
  getCurrentRepository,
  listRepositoryWorkspaces,
} from "../../shared/vcs.ts"

export const commandWorktreeList = Command.make("list").pipe(
  Command.withAlias("ls"),
  Command.withDescription(
    "List git worktrees or jj workspaces for the current repository.",
  ),
  Command.withHandler(
    Effect.fnUntraced(function* () {
      const repository = yield* getCurrentRepository
      const workspaces = yield* listRepositoryWorkspaces(repository)

      if (workspaces.length === 0) {
        console.log(
          repository.kind === "git"
            ? "No worktrees found."
            : "No workspaces found.",
        )
        return
      }

      console.log(
        `${repository.kind === "git" ? "Git worktrees" : "jj workspaces"} for ${repository.root}`,
      )
      console.log("")
      for (const workspace of workspaces) {
        console.log(formatRepositoryWorkspace(workspace))
      }
    }),
  ),
)
