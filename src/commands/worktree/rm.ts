import { Effect, Option } from "effect"
import { Argument, Command, Prompt } from "effect/unstable/cli"
import {
  formatRepositoryWorkspace,
  getCurrentRepository,
  listRepositoryWorkspaces,
  removeRepositoryWorkspace,
} from "../../shared/vcs.ts"

const selector = Argument.string("selector").pipe(
  Argument.optional,
  Argument.withDescription(
    "Optional. Branch name, workspace name, path, or basename to remove. If omitted, lalph prompts you to choose.",
  ),
)

export const commandWorktreeRm = Command.make("rm", {
  selector,
}).pipe(
  Command.withDescription(
    "Remove a git worktree or jj workspace from the current repository.",
  ),
  Command.withHandler(
    Effect.fnUntraced(function* ({
      selector,
    }: {
      readonly selector: Option.Option<string>
    }) {
      const repository = yield* getCurrentRepository
      const workspaces = yield* listRepositoryWorkspaces(repository)
      const removable = workspaces.filter(
        (workspace) => !workspace.current && !workspace.default,
      )

      if (removable.length === 0) {
        console.log(
          repository.kind === "git"
            ? "No removable worktrees found."
            : "No removable workspaces found.",
        )
        return
      }

      const resolvedSelector = Option.getOrElse(selector, () => undefined)

      const selection =
        resolvedSelector ??
        (yield* Prompt.autoComplete({
          message:
            repository.kind === "git"
              ? "Select a worktree to remove:"
              : "Select a workspace to remove:",
          choices: removable.map((workspace) => ({
            title: formatRepositoryWorkspace(workspace),
            value: workspace.path,
          })),
        }))!

      const removed = yield* removeRepositoryWorkspace(
        repository,
        selection,
      ).pipe(
        Effect.catchTags({
          RepositoryWorkspaceAmbiguous: (error) => {
            console.log(error.message)
            return Effect.void
          },
          RepositoryWorkspaceIsCurrent: (error) => {
            console.log(error.message)
            return Effect.void
          },
          RepositoryWorkspaceIsDefault: (error) => {
            console.log(error.message)
            return Effect.void
          },
          RepositoryWorkspaceNotFound: (error) => {
            console.log(error.message)
            return Effect.void
          },
          RepositoryWorkspaceRemoveError: (error) => {
            console.log(error.message)
            return Effect.void
          },
        }),
      )

      if (!removed) {
        return
      }

      console.log(`Removed ${formatRepositoryWorkspace(removed)}`)
    }),
  ),
)
