import {
  Data,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schema,
  ServiceMap,
} from "effect"
import type { PlatformError } from "effect/PlatformError"
import { Atom, AtomRegistry } from "effect/unstable/reactivity"
import type { ChildProcessSpawner } from "effect/unstable/process"
import {
  HookCommandFailedError,
  Hooks,
  HooksConfigParseError,
} from "./Hooks.ts"
import { IssueSource, type IssueSourceError } from "./IssueSource.ts"
import { Prd } from "./Prd.ts"
import { CurrentProjectId } from "./Settings.ts"
import { projectById } from "./Projects.ts"
import type { Worktree } from "./Worktree.ts"
import { CurrentWorkerState } from "./Workers.ts"
import {
  getCurrentRepository,
  resolveTargetBranch,
  targetBranchToJjBookmark,
  targetBranchToJjRevision,
  type VcsKind,
} from "./shared/vcs.ts"

export class GitFlow extends ServiceMap.Service<
  GitFlow,
  {
    readonly requiresGithubPr: boolean
    readonly branch: string | undefined
    readonly setupInstructions: (options: {
      readonly githubPrNumber: number | undefined
    }) => string
    readonly completionAction: string
    readonly commitInstructions: (options: {
      readonly githubPrNumber: number | undefined
      readonly githubPrInstructions: string
      readonly targetBranch: string | undefined
      readonly taskId: string
    }) => string
    readonly reviewInstructions: string
    readonly postWork: (options: {
      readonly worktree: Worktree["Service"]
      readonly targetBranch: string | undefined
      readonly issueId: string
    }) => Effect.Effect<
      void,
      IssueSourceError | PlatformError | GitFlowError,
      | Prd
      | IssueSource
      | CurrentProjectId
      | ChildProcessSpawner.ChildProcessSpawner
    >
    readonly autoMerge: (options: {
      readonly targetBranch: string | undefined
      readonly issueId: string
      readonly worktree: Worktree["Service"]
    }) => Effect.Effect<
      void,
      IssueSourceError | PlatformError | GitFlowError,
      Prd | IssueSource | CurrentProjectId | FileSystem.FileSystem
    >
  }
>()("lalph/GitFlow") {}

export type GitFlowLayer = Layer.Layer<
  GitFlow,
  never,
  Layer.Services<typeof GitFlowPR | typeof GitFlowCommit | typeof GitFlowRalph>
>

const setupInstructionsForPr = (
  vcsKind: VcsKind,
  githubPrNumber: number | undefined,
) => {
  if (githubPrNumber) {
    return vcsKind === "git"
      ? `The Github PR #${githubPrNumber} has been detected for this task and the branch has been checked out.
   - Review feedback in the .lalph/feedback.md file.`
      : `The Github PR #${githubPrNumber} has been detected for this task and the workspace has been prepared on top of the PR branch.
   - Review feedback in the .lalph/feedback.md file.`
  }

  return vcsKind === "git"
    ? `Create a new branch for the task using the format \`{task id}/description\`, using the current HEAD as the base (don't checkout any other branches first).`
    : `Create a new jj bookmark for the task using the format \`{task id}/description\` and keep working in the current workspace.`
}

const commitInstructionsForPr = (options: {
  readonly githubPrInstructions: string
  readonly githubPrNumber: number | undefined
  readonly targetBranch: string | undefined
  readonly vcsKind: VcsKind
}) => {
  const action =
    options.vcsKind === "git"
      ? !options.githubPrNumber
        ? "Create a pull request for this task. If the target branch does not exist, create it first."
        : "Commit and push your changes to the pull request."
      : !options.githubPrNumber
        ? "Push the task bookmark with jj and create a pull request for it. If the target branch does not exist, create it first."
        : "Record the updated jj change, move the PR bookmark to `@`, and push it back to the same pull request branch."

  const permissions =
    options.vcsKind === "git"
      ? "- You have full permission to push branches, create PRs or create git commits."
      : "- You have full permission to create jj commits, move bookmarks, push bookmarks, and create PRs."

  return `${action}
   ${options.githubPrInstructions}
   The PR description should include a summary of the changes made.
   - Write the PR title and description in English.${options.targetBranch ? `\n   - The target branch for the PR should be \`${options.targetBranch}\`.` : ""}
   - **DO NOT** commit any of the files in the \`.lalph\` directory.
   ${permissions}`
}

const reviewInstructionsForPr = (vcsKind: VcsKind) =>
  vcsKind === "git"
    ? `You are already on the PR branch with their changes.
After making any changes, commit and push them to the same pull request.

- **DO NOT** commit any of the files in the \`.lalph\` directory.
- You have full permission to push branches, create PRs or create git commits.`
    : `You are already in a jj workspace based on the PR branch.
After making any changes, record them in jj, move the PR bookmark to \`@\`, and push it to the same pull request branch.

- **DO NOT** commit any of the files in the \`.lalph\` directory.
- You have full permission to create jj commits, move bookmarks, push bookmarks, and create PRs.`

const mapHookErrorToGitFlowError = <A, R>(
  effect: Effect.Effect<
    A,
    | HookCommandFailedError
    | HooksConfigParseError
    | PlatformError
    | Schema.SchemaError,
    R
  >,
) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is HookCommandFailedError =>
        error instanceof HookCommandFailedError,
      (error) =>
        Effect.fail(
          new GitFlowError({
            message: error.message,
          }),
        ),
    ),
    Effect.catchIf(
      (error): error is HooksConfigParseError =>
        error instanceof HooksConfigParseError,
      (error) =>
        Effect.fail(
          new GitFlowError({
            message: `Failed to load pre-merge hooks: ${error.message}`,
          }),
        ),
    ),
    Effect.catchIf(Schema.isSchemaError, (error) =>
      Effect.fail(
        new GitFlowError({
          message: `Invalid hooks configuration: ${error.message}`,
        }),
      ),
    ),
  )

export const GitFlowPR = Layer.effect(
  GitFlow,
  Effect.gen(function* () {
    const repository = yield* getCurrentRepository
    const hooks = yield* Hooks

    return GitFlow.of({
      requiresGithubPr: true,
      branch: undefined,

      setupInstructions: ({ githubPrNumber }) =>
        setupInstructionsForPr(repository.kind, githubPrNumber),

      completionAction: "pushing",

      commitInstructions: (options) =>
        commitInstructionsForPr({
          githubPrInstructions: options.githubPrInstructions,
          githubPrNumber: options.githubPrNumber,
          targetBranch: options.targetBranch,
          vcsKind: repository.kind,
        }),

      reviewInstructions: reviewInstructionsForPr(repository.kind),

      postWork: () => Effect.void,
      autoMerge: Effect.fnUntraced(function* (options) {
        const prd = yield* Prd
        const source = yield* IssueSource
        const projectId = yield* CurrentProjectId
        const worktree = options.worktree

        let prState = (yield* worktree.viewPrState()).pipe(
          Option.filter((pr) => pr.state === "OPEN"),
        )

        yield* Effect.log("PR state", prState)
        if (Option.isNone(prState)) {
          return yield* new GitFlowError({
            message: `No open PR found for auto-merge.`,
          })
        }
        if (options.targetBranch) {
          yield* worktree.exec`gh pr edit --base ${options.targetBranch}`
        }
        yield* mapHookErrorToGitFlowError(
          hooks.executeHook({
            directory: worktree.directory,
            fallbackDirectory: worktree.repository.root,
            hookType: "pre-merge",
            runCommand: worktree.execShell,
            templateValues: yield* worktree.getHookTemplateValues,
          }),
        )
        yield* worktree.exec`gh pr merge -sd`
        yield* Effect.sleep(Duration.seconds(3))
        prState = yield* worktree.viewPrState(prState.value.number)
        yield* Effect.log("PR state after merge", prState)
        if (Option.isSome(prState) && prState.value.state === "MERGED") {
          const issue = yield* prd.findById(options.issueId)
          if (issue && issue.state !== "done") {
            yield* source.updateIssue({
              projectId,
              issueId: options.issueId,
              state: "done",
            })
          }
          return
        }
        yield* Effect.log("Flagging unmergable PR")
        yield* prd.flagUnmergable({ issueId: options.issueId })
        yield* worktree.exec`gh pr close -d`
      }),
    })
  }),
).pipe(Layer.provideMerge(Hooks.layer))

export const GitFlowCommit = Layer.effect(
  GitFlow,
  Effect.gen(function* () {
    const currentWorker = yield* CurrentWorkerState
    const repository = yield* getCurrentRepository
    const workerState = yield* Atom.get(currentWorker.state)
    const projectId = yield* CurrentProjectId
    const project = yield* projectById(projectId)
    const checkoutMode = Option.match(project, {
      onNone: () => "worktree" as const,
      onSome: (project) => project.checkoutMode,
    })

    return GitFlow.of({
      requiresGithubPr: false,
      branch: `lalph/worker-${workerState.id}-${Date.now()}`,

      setupInstructions: () =>
        repository.kind === "git"
          ? checkoutMode === "worktree"
            ? `You are already in an isolated checkout for this task. Do not switch to another repository while working.`
            : `Work directly on the current branch for this task. Do not create or switch to a temporary worktree.`
          : checkoutMode === "worktree"
            ? `You are already in an isolated jj workspace for this task. Do not switch workspaces while working.`
            : `A jj change has already been created for this task in the current workspace. Work directly in that change and do not create or switch to a temporary workspace.`,

      completionAction:
        repository.kind === "git" ? "committing" : "updating the jj change",

      commitInstructions: (options) =>
        repository.kind === "git"
          ? `When you have completed your changes, **you must** commit them to the current local branch. Do not git push your changes or switch branches.
   - Include \`References ${options.taskId}\` in each commit message.
   - Write commit messages in English.
   - **DO NOT** commit any of the files in the \`.lalph\` directory.`
          : `When you have completed your changes, **you must** update the current jj change using \`jj describe -m\`. Do not use \`jj commit -m\`, do not push your changes, and do not switch workspaces.
   - Keep the issue id and task title visible in the first line of the jj change description.
   - Include \`References ${options.taskId}\` somewhere in the jj change description.
   - Write the jj change description in English.
   - **DO NOT** commit any of the files in the \`.lalph\` directory.`,

      reviewInstructions:
        repository.kind === "git"
          ? `You are already on the branch with their changes.
After making any changes, **you must** commit them to the same branch.
But you **do not** need to git push your changes or switch branches.

 - Include \`References {task id}\` in each commit message.
 - Write commit messages in English.
 - **DO NOT** commit any of the files in the \`.lalph\` directory.
 - You have full permission to create git commits.`
          : `You are already on the jj change with their work.
After making any changes, **you must** update the same jj change with \`jj describe -m\`.
But you **do not** need to push your changes or switch workspaces, and you should not create a new jj change.

 - Keep the issue id and task title visible in the first line of the jj change description.
 - Include \`References {task id}\` in the jj change description.
 - Write the jj change description in English.
 - **DO NOT** commit any of the files in the \`.lalph\` directory.
 - You have full permission to create jj commits.`,

      postWork: Effect.fnUntraced(function* ({
        worktree,
        targetBranch,
        issueId,
      }) {
        if (!targetBranch) {
          return yield* Effect.logWarning(
            "GitFlowCommit: No target branch specified, skipping postWork.",
          )
        }
        const prd = yield* Prd

        const parsed = yield* resolveTargetBranch({
          repository: worktree.repository,
          targetBranch,
        })

        if (worktree.repository.kind === "git") {
          if (Option.isSome(parsed.remote)) {
            yield* worktree.exec`git fetch ${parsed.remote.value}`
          }
          yield* worktree.exec`git restore --worktree .`

          const rebaseResult =
            yield* worktree.exec`git rebase ${parsed.branchWithRemote}`
          if (rebaseResult !== 0) {
            yield* prd.flagUnmergable({ issueId })
            return yield* new GitFlowError({
              message: `Failed to rebase onto ${parsed.branchWithRemote}. Aborting task.`,
            })
          }

          if (Option.isSome(parsed.remote)) {
            const pushResult =
              yield* worktree.exec`git push ${parsed.remote.value} ${`HEAD:${parsed.branch}`}`
            if (pushResult !== 0) {
              yield* prd.flagUnmergable({ issueId })
              return yield* new GitFlowError({
                message: `Failed to push changes to ${parsed.branchWithRemote}. Aborting task.`,
              })
            }
          }
          return
        }

        if (Option.isSome(parsed.remote)) {
          yield* worktree.exec`jj git fetch --remote ${parsed.remote.value} --branch ${parsed.branch}`
          yield* worktree.exec`jj bookmark track ${parsed.branch} --remote ${parsed.remote.value}`
        }
        const rebaseResult =
          yield* worktree.exec`jj rebase --branch ${"@"} --onto ${targetBranchToJjBookmark(parsed)}`
        if (rebaseResult !== 0) {
          yield* prd.flagUnmergable({ issueId })
          return yield* new GitFlowError({
            message: `Failed to rebase onto ${targetBranchToJjBookmark(parsed)}. Aborting task.`,
          })
        }
        const setBookmarkResult =
          yield* worktree.exec`jj bookmark set ${parsed.branch} --revision ${"@"}`
        if (setBookmarkResult !== 0) {
          yield* prd.flagUnmergable({ issueId })
          return yield* new GitFlowError({
            message: `Failed to update jj bookmark ${parsed.branch}. Aborting task.`,
          })
        }

        if (Option.isSome(parsed.remote)) {
          const pushResult =
            yield* worktree.exec`jj git push --remote ${parsed.remote.value} --bookmark ${parsed.branch}`
          if (pushResult !== 0) {
            yield* prd.flagUnmergable({ issueId })
            return yield* new GitFlowError({
              message: `Failed to push jj bookmark ${targetBranchToJjRevision(parsed)}. Aborting task.`,
            })
          }
        }
      }),
      autoMerge: Effect.fnUntraced(function* (options) {
        const source = yield* IssueSource
        const projectId = yield* CurrentProjectId
        const issue = yield* source.findById(projectId, options.issueId)
        if (!issue || issue.state !== "in-review") {
          return
        }
        yield* source.updateIssue({
          projectId,
          issueId: options.issueId,
          state: "done",
        })
      }),
    })
  }),
).pipe(Layer.provide(AtomRegistry.layer))

export const GitFlowRalph = Layer.effect(
  GitFlow,
  Effect.gen(function* () {
    const currentWorker = yield* CurrentWorkerState
    const repository = yield* getCurrentRepository
    const projectId = yield* CurrentProjectId
    const project = yield* projectById(projectId)
    const checkoutMode = Option.match(project, {
      onNone: () => "worktree" as const,
      onSome: (project) => project.checkoutMode,
    })
    const workerState = yield* Atom.get(currentWorker.state)

    return GitFlow.of({
      requiresGithubPr: false,
      branch: `lalph/worker-${workerState.id}-${Date.now()}`,

      setupInstructions: () =>
        repository.kind === "git"
          ? checkoutMode === "worktree"
            ? `You are already in an isolated checkout for this task. Do not switch to another repository while working.`
            : `Work directly on the current branch for this task. Do not create or switch to a temporary worktree.`
          : checkoutMode === "worktree"
            ? `You are already in an isolated jj workspace for this task. Do not switch workspaces while working.`
            : `A jj change has already been created for this task in the current workspace. Work directly in that change and do not create or switch to a temporary workspace.`,

      completionAction:
        repository.kind === "git" ? "committing" : "updating the jj change",

      commitInstructions: () =>
        repository.kind === "git"
          ? `When you have completed your changes, **you must** commit them to the current local branch. Do not git push your changes or switch branches.
   - Write commit messages in English.
   - **DO NOT** commit any of the files in the \`.lalph\` directory.`
          : `When you have completed your changes, **you must** update the current jj change using \`jj describe -m\`. Do not use \`jj commit -m\`, do not push your changes, and do not switch workspaces.
   - Keep the task title visible in the first line of the jj change description.
   - Write the jj change description in English.
   - **DO NOT** commit any of the files in the \`.lalph\` directory.`,

      reviewInstructions:
        repository.kind === "git"
          ? `You are already on the branch with their changes.
After making any changes, **you must** commit them to the same branch.
But you **do not** need to git push your changes or switch branches.

 - Write commit messages in English.
 - **DO NOT** commit any of the files in the \`.lalph\` directory.
 - You have full permission to create git commits.`
          : `You are already on the jj change with their work.
After making any changes, **you must** update the same jj change with \`jj describe -m\`.
But you **do not** need to push your changes or switch workspaces, and you should not create a new jj change.

 - Keep the task title visible in the first line of the jj change description.
 - Write the jj change description in English.
 - **DO NOT** commit any of the files in the \`.lalph\` directory.
 - You have full permission to create jj commits.`,

      postWork: Effect.fnUntraced(function* ({ worktree, targetBranch }) {
        if (!targetBranch) {
          return yield* Effect.logWarning(
            "GitFlowRalph: No target branch specified, skipping postWork.",
          )
        }

        const parsed = yield* resolveTargetBranch({
          repository: worktree.repository,
          targetBranch,
        })

        if (worktree.repository.kind === "git") {
          if (Option.isSome(parsed.remote)) {
            yield* worktree.exec`git fetch ${parsed.remote.value}`
          }
          yield* worktree.exec`git restore --worktree .`

          const rebaseResult =
            yield* worktree.exec`git rebase ${parsed.branchWithRemote}`
          if (rebaseResult !== 0) {
            return yield* new GitFlowError({
              message: `Failed to rebase onto ${parsed.branchWithRemote}. Aborting task.`,
            })
          }

          if (Option.isSome(parsed.remote)) {
            const pushResult =
              yield* worktree.exec`git push ${parsed.remote.value} ${`HEAD:${parsed.branch}`}`
            if (pushResult !== 0) {
              return yield* new GitFlowError({
                message: `Failed to push changes to ${parsed.branchWithRemote}. Aborting task.`,
              })
            }
          }
          return
        }

        if (Option.isSome(parsed.remote)) {
          yield* worktree.exec`jj git fetch --remote ${parsed.remote.value} --branch ${parsed.branch}`
          yield* worktree.exec`jj bookmark track ${parsed.branch} --remote ${parsed.remote.value}`
        }
        const rebaseResult =
          yield* worktree.exec`jj rebase --branch ${"@"} --onto ${targetBranchToJjBookmark(parsed)}`
        if (rebaseResult !== 0) {
          return yield* new GitFlowError({
            message: `Failed to rebase onto ${targetBranchToJjBookmark(parsed)}. Aborting task.`,
          })
        }
        const setBookmarkResult =
          yield* worktree.exec`jj bookmark set ${parsed.branch} --revision ${"@"}`
        if (setBookmarkResult !== 0) {
          return yield* new GitFlowError({
            message: `Failed to update jj bookmark ${parsed.branch}. Aborting task.`,
          })
        }

        if (Option.isSome(parsed.remote)) {
          const pushResult =
            yield* worktree.exec`jj git push --remote ${parsed.remote.value} --bookmark ${parsed.branch}`
          if (pushResult !== 0) {
            return yield* new GitFlowError({
              message: `Failed to push jj bookmark ${targetBranchToJjRevision(parsed)}. Aborting task.`,
            })
          }
        }
      }),
      autoMerge: () => Effect.void,
    })
  }),
).pipe(Layer.provide(AtomRegistry.layer))

// Errors
export class GitFlowError extends Data.TaggedError("GitFlowError")<{
  message: string
}> {}
