import {
  Data,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  pipe,
  Schema,
} from "effect"
import { PromptGen } from "../PromptGen.ts"
import { Prd } from "../Prd.ts"
import { Worktree } from "../Worktree.ts"
import { Command, Flag } from "effect/unstable/cli"
import { CurrentIssueSource } from "../CurrentIssueSource.ts"
import { commandRoot } from "./root.ts"
import { CurrentProjectId, Settings } from "../Settings.ts"
import { addOrUpdateProject, selectProject } from "../Projects.ts"
import { agentPlanner } from "../Agents/planner.ts"
import { agentTasker } from "../Agents/tasker.ts"
import { commandPlanTasks } from "./plan/tasks.ts"
import { Editor } from "../Editor.ts"
import { selectCliAgentPreset } from "../Presets.ts"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import {
  resolveTargetBranch,
  targetBranchToJjBookmark,
  targetBranchToJjRevision,
} from "../shared/vcs.ts"
import type { CliAgentPreset } from "../domain/CliAgentPreset.ts"
import { ClankaMuxerLayer } from "../Clanka.ts"

const dangerous = Flag.boolean("dangerous").pipe(
  Flag.withAlias("d"),
  Flag.withDescription(
    "Skip permission prompts while generating the specification from your plan",
  ),
)

const withNewProject = Flag.boolean("new").pipe(
  Flag.withAlias("n"),
  Flag.withDescription(
    "Create a new project (via prompts) before starting plan mode",
  ),
)

const file = Flag.file("file", { mustExist: true }).pipe(
  Flag.withAlias("f"),
  Flag.withDescription(
    "Read the plan from a markdown file instead of opening an editor",
  ),
  Flag.optional,
)

export const commandPlan = Command.make("plan", {
  dangerous,
  withNewProject,
  file,
}).pipe(
  Command.withDescription(
    "Draft a plan in your editor (or use --file); then generate a specification under --specs and create PRD tasks from it. Use --new to create a project first, and --dangerous to skip permission prompts during spec generation.",
  ),
  Command.withHandler(
    Effect.fnUntraced(
      function* ({ dangerous, withNewProject, file }) {
        const editor = yield* Editor
        const fs = yield* FileSystem.FileSystem

        const thePlan = yield* Effect.matchEffect(file.asEffect(), {
          onFailure: () => editor.editTemp({ suffix: ".md" }),
          onSuccess: (path) => fs.readFileString(path).pipe(Effect.asSome),
        })

        if (Option.isNone(thePlan)) return

        yield* Effect.addFinalizer((exit) => {
          if (Exit.isSuccess(exit)) return Effect.void
          return pipe(
            editor.saveTemp(thePlan.value, { suffix: ".md" }),
            Effect.flatMap((file) => Effect.log(`Saved your plan to: ${file}`)),
            Effect.ignore,
          )
        })

        // We nest this effect, so we can launch the editor first as fast as
        // possible
        yield* Effect.gen(function* () {
          const project = withNewProject
            ? yield* addOrUpdateProject()
            : yield* selectProject
          const { specsDirectory } = yield* commandRoot
          const preset = yield* selectCliAgentPreset

          yield* plan({
            plan: thePlan.value,
            specsDirectory,
            targetBranch: project.targetBranch,
            dangerous,
            preset,
          }).pipe(Effect.provideService(CurrentProjectId, project.id))
        }).pipe(
          Effect.provide([
            Settings.layer,
            CurrentIssueSource.layer,
            ClankaMuxerLayer,
          ]),
        )
      },
      Effect.scoped,
      Effect.provide(Editor.layer),
    ),
  ),
  Command.withSubcommands([commandPlanTasks]),
)

const plan = Effect.fnUntraced(
  function* (options: {
    readonly plan: string
    readonly specsDirectory: string
    readonly targetBranch: Option.Option<string>
    readonly dangerous: boolean
    readonly preset: CliAgentPreset
  }) {
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path
    const worktree = yield* Worktree

    yield* agentPlanner({
      plan: options.plan,
      specsDirectory: options.specsDirectory,
      dangerous: options.dangerous,
      preset: options.preset,
    })

    const planDetails = yield* pipe(
      fs.readFileString(
        pathService.join(worktree.directory, ".lalph", "plan.json"),
      ),
      Effect.flatMap(Schema.decodeEffect(PlanDetails)),
      Effect.mapError(() => new SpecNotFound()),
    )

    if (Option.isSome(options.targetBranch)) {
      yield* commitAndPushSpecification({
        specsDirectory: options.specsDirectory,
        targetBranch: options.targetBranch.value,
      })
    }

    yield* Effect.log("Converting specification into tasks")

    yield* agentTasker({
      specificationPath: planDetails.specification,
      specsDirectory: options.specsDirectory,
      preset: options.preset,
    })

    if (worktree.mode === "worktree" && !worktree.inExisting) {
      yield* pipe(
        fs.copy(
          pathService.join(worktree.directory, options.specsDirectory),
          options.specsDirectory,
          { overwrite: true },
        ),
        Effect.ignore,
      )
    }
  },
  Effect.scoped,
  Effect.provide([
    PromptGen.layer,
    Prd.layerProvided,
    Worktree.layer,
    Settings.layer,
    CurrentIssueSource.layer,
  ]),
)

export class SpecNotFound extends Data.TaggedError("SpecNotFound") {
  readonly message = "The AI agent failed to produce a specification."
}

export class SpecGitError extends Data.TaggedError("SpecGitError")<{
  readonly message: string
}> {}

const commitAndPushSpecification = Effect.fnUntraced(
  function* (options: {
    readonly specsDirectory: string
    readonly targetBranch: string
  }) {
    const worktree = yield* Worktree
    const pathService = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

    const absSpecsDirectory = pathService.join(
      worktree.directory,
      options.specsDirectory,
    )

    const git = (args: ReadonlyArray<string>) =>
      ChildProcess.make("git", [...args], {
        cwd: worktree.directory,
        stdout: "inherit",
        stderr: "inherit",
      }).pipe(spawner.exitCode)

    const parsed = yield* resolveTargetBranch({
      repository: worktree.repository,
      targetBranch: options.targetBranch,
    })

    if (worktree.repository.kind === "git") {
      const addCode = yield* git(["add", absSpecsDirectory])
      if (addCode !== 0) {
        return yield* new SpecGitError({
          message: "Failed to stage specification changes.",
        })
      }

      const commitCode = yield* git([
        "commit",
        "-m",
        "Update plan specification",
      ])
      if (commitCode !== 0) {
        return yield* new SpecGitError({
          message: "Failed to commit the generated specification changes.",
        })
      }

      if (Option.isSome(parsed.remote)) {
        yield* git(["push", parsed.remote.value, `HEAD:${parsed.branch}`])
      }
      return
    }

    const describeCode =
      yield* worktree.exec`jj describe --message ${"Update plan specification"}`
    if (describeCode !== 0) {
      return yield* new SpecGitError({
        message: "Failed to describe the generated specification change.",
      })
    }

    if (Option.isSome(parsed.remote)) {
      yield* worktree.exec`jj git fetch --remote ${parsed.remote.value} --branch ${parsed.branch}`
      yield* worktree.exec`jj bookmark track ${parsed.branch} --remote ${parsed.remote.value}`
    }
    const rebaseCode =
      yield* worktree.exec`jj rebase --branch ${"@"} --onto ${targetBranchToJjBookmark(parsed)}`
    if (rebaseCode !== 0) {
      return yield* new SpecGitError({
        message: "Failed to rebase the generated specification change.",
      })
    }
    const bookmarkCode =
      yield* worktree.exec`jj bookmark set ${parsed.branch} --revision ${"@"}`
    if (bookmarkCode !== 0) {
      return yield* new SpecGitError({
        message:
          "Failed to update the target bookmark for the specification change.",
      })
    }

    if (Option.isSome(parsed.remote)) {
      const pushCode =
        yield* worktree.exec`jj git push --remote ${parsed.remote.value} --bookmark ${parsed.branch}`
      if (pushCode !== 0) {
        return yield* new SpecGitError({
          message: `Failed to push the generated specification change to ${targetBranchToJjRevision(parsed)}.`,
        })
      }
    }
  },
  Effect.ignore({ log: "Warn" }),
)

const PlanDetails = Schema.fromJsonString(
  Schema.Struct({
    specification: Schema.String,
  }),
)
