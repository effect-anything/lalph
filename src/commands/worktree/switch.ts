import { Effect, Option } from "effect"
import { Argument, Command, Prompt } from "effect/unstable/cli"
import { Hooks } from "../../Hooks.ts"
import { layerProjectIdPrompt, projectById } from "../../Projects.ts"
import { CurrentProjectId } from "../../Settings.ts"
import { makeExecHelpers } from "../../Worktree.ts"
import { launchInteractiveShell } from "../../shared/interactiveShell.ts"
import {
  resolveLalphDirectory,
  syncLalphDirectory,
} from "../../shared/lalphDirectory.ts"
import {
  formatRepositoryWorkspace,
  getCurrentRepository,
  getGithubRepository,
  listRepositoryWorkspaces,
  resolveRepositoryWorkspace,
} from "../../shared/vcs.ts"

const selector = Argument.string("selector").pipe(
  Argument.optional,
  Argument.withDescription(
    "Optional. Branch name, workspace name, path, or basename to open. If omitted, lalph prompts you to choose.",
  ),
)

export const commandWorktreeSwitch = Command.make("switch", {
  selector,
}).pipe(
  Command.withAlias("s"),
  Command.withDescription(
    "Run post-switch hooks for an existing git worktree or jj workspace, then open a shell in it.",
  ),
  Command.withHandler(
    Effect.fnUntraced(
      function* ({ selector }: { readonly selector: Option.Option<string> }) {
        const projectId = yield* CurrentProjectId
        const project = yield* projectById(projectId)
        const repository = yield* getCurrentRepository
        const workspaces = yield* listRepositoryWorkspaces(repository)
        const switchableWorkspaces = workspaces.filter(
          (workspace) => !workspace.current,
        )

        if (workspaces.length === 0) {
          console.log(
            repository.kind === "git"
              ? "No worktrees found."
              : "No workspaces found.",
          )
          return
        }

        const target = Option.isSome(selector)
          ? yield* resolveRepositoryWorkspace(repository, selector.value).pipe(
              Effect.catchTag("RepositoryWorkspaceAmbiguous", (error) => {
                console.log(error.message)
                return Effect.void
              }),
              Effect.catchTag("RepositoryWorkspaceNotFound", (error) => {
                console.log(error.message)
                return Effect.void
              }),
            )
          : switchableWorkspaces.length === 0
            ? undefined
            : (yield* Prompt.autoComplete({
                message:
                  repository.kind === "git"
                    ? "Select a worktree to open:"
                    : "Select a workspace to open:",
                choices: switchableWorkspaces.map((workspace) => ({
                  title: formatRepositoryWorkspace(workspace),
                  value: workspace,
                })),
              }))!

        if (!target) {
          if (switchableWorkspaces.length === 0) {
            console.log(
              repository.kind === "git"
                ? "Already in the only available worktree."
                : "Already in the only available workspace.",
            )
          }
          return
        }

        if (target.current) {
          console.log(
            `Already in ${formatRepositoryWorkspace(target)}. Pick a different ${repository.kind === "git" ? "worktree" : "workspace"}.`,
          )
          return
        }

        const lalphDirectory = yield* resolveLalphDirectory
        yield* syncLalphDirectory({
          sourceDirectory: lalphDirectory,
          targetDirectory: target.path,
        })

        const githubRepo = yield* getGithubRepository(repository).pipe(
          Effect.map(Option.getOrUndefined),
        )
        const targetBranch = Option.isSome(project)
          ? Option.getOrUndefined(project.value.targetBranch)
          : undefined
        const helpers = yield* makeExecHelpers({
          directory: target.path,
          githubRepo,
          mode: target.current ? "in-place" : "worktree",
          projectId,
          repository,
          targetBranch,
        })

        yield* helpers.runPostSwitchHooks("switchWorkspace")
        yield* launchInteractiveShell(target.path)
      },
      Effect.provide([Hooks.layer, layerProjectIdPrompt]),
    ),
  ),
)
