import {
  Chunk,
  Duration,
  Effect,
  FileSystem,
  flow,
  identity,
  Layer,
  Option,
  Path,
  PlatformError,
  Schema,
  ServiceMap,
  Stream,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { AtomRegistry } from "effect/unstable/reactivity"
import type { AnyCliAgent } from "./domain/CliAgent.ts"
import type { ProjectCheckoutMode } from "./domain/Project.ts"
import {
  HookCommandFailedError,
  type HookTemplateValues,
  Hooks,
  HooksConfigParseError,
} from "./Hooks.ts"
import { projectById } from "./Projects.ts"
import { CurrentProjectId } from "./Settings.ts"
import { constWorkerMaxOutputChunks, CurrentWorkerState } from "./Workers.ts"
import {
  resolveLalphDirectory,
  syncLalphDirectory,
} from "./shared/lalphDirectory.ts"
import { withStallTimeout } from "./shared/stream.ts"
import {
  type RepositoryInfo,
  getCurrentRepository,
  getGithubRepository,
  makeJjWorkspaceName,
  resolveTargetBranch,
  targetBranchToJjRevision,
} from "./shared/vcs.ts"

export class Worktree extends ServiceMap.Service<Worktree>()("lalph/Worktree", {
  make: buildWorktree(),
}) {
  static layer = Layer.effect(this, this.make).pipe(
    Layer.provideMerge(Hooks.layer),
  )
  static layerWorktree = Layer.effect(
    this,
    buildWorktree({ forceCheckoutMode: "worktree" }),
  ).pipe(Layer.provideMerge(Hooks.layer))
  static layerLocal = Layer.effect(
    this,
    Effect.gen(function* () {
      const pathService = yield* Path.Path
      const fs = yield* FileSystem.FileSystem
      const repository = yield* getCurrentRepository
      const projectId = yield* CurrentProjectId
      const targetBranch = yield* getTargetBranch.pipe(
        Effect.map(Option.getOrUndefined),
      )
      const githubRepo = yield* getGithubRepository(repository).pipe(
        Effect.map(Option.getOrUndefined),
      )
      const directory = repository.root
      return {
        directory,
        githubRepo,
        inExisting: yield* fs.exists(
          pathService.join(directory, ".lalph", "prd.yml"),
        ),
        mode: "in-place",
        repository,
        ...(yield* makeExecHelpers({
          directory,
          githubRepo,
          mode: "in-place",
          projectId,
          repository,
          targetBranch,
        })),
      }
    }),
  ).pipe(Layer.provideMerge(Hooks.layer))
}

function buildWorktree(options?: {
  readonly forceCheckoutMode?: ProjectCheckoutMode
}) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const repository = yield* getCurrentRepository
    const projectId = yield* CurrentProjectId
    const checkoutMode = options?.forceCheckoutMode ?? (yield* getCheckoutMode)
    const targetBranch = yield* getTargetBranch.pipe(
      Effect.map(Option.getOrUndefined),
    )
    const githubRepo = yield* getGithubRepository(repository).pipe(
      Effect.map(Option.getOrUndefined),
    )

    if (checkoutMode === "in-place") {
      const directory = repository.root
      const inExisting: boolean = false
      yield* fs.makeDirectory(pathService.join(directory, ".lalph"), {
        recursive: true,
      })
      return {
        directory,
        githubRepo,
        inExisting,
        mode: checkoutMode,
        repository,
        ...(yield* makeExecHelpers({
          directory,
          githubRepo,
          mode: checkoutMode,
          projectId,
          repository,
          targetBranch,
        })),
      }
    }

    const inExisting: boolean = false
    const directory = yield* fs.makeTempDirectory()

    if (repository.kind === "git") {
      yield* Effect.addFinalizer(
        Effect.fnUntraced(function* () {
          yield* execIgnore(
            spawner,
            ChildProcess.make`git worktree remove --force ${directory}`,
          )
        }),
      )

      yield* ChildProcess.make`git worktree add ${directory} -d HEAD`.pipe(
        spawner.exitCode,
      )
    } else {
      const workspaceName = makeJjWorkspaceName(pathService.basename(directory))

      yield* Effect.addFinalizer(
        Effect.fnUntraced(function* () {
          yield* execIgnore(
            spawner,
            ChildProcess.make({
              cwd: repository.root,
            })`jj workspace forget ${workspaceName}`,
          )
          yield* Effect.ignore(fs.remove(directory, { recursive: true }))
        }),
      )

      yield* ChildProcess.make({
        cwd: repository.root,
      })`jj workspace add ${directory} --name ${workspaceName}`.pipe(
        spawner.exitCode,
      )
    }

    yield* fs.makeDirectory(pathService.join(directory, ".lalph"), {
      recursive: true,
    })
    const lalphDirectory = yield* resolveLalphDirectory
    yield* syncLalphDirectory({
      sourceDirectory: lalphDirectory,
      targetDirectory: directory,
    })

    const execHelpers = yield* makeExecHelpers({
      directory,
      githubRepo,
      mode: checkoutMode,
      projectId,
      repository,
      targetBranch,
    })
    yield* setupWorktree({
      directory,
      exec: execHelpers.exec,
      execShell: execHelpers.execShell,
      getHookTemplateValues: execHelpers.getHookTemplateValues,
      repository,
    })

    return {
      directory,
      githubRepo,
      inExisting,
      mode: checkoutMode,
      repository,
      ...execHelpers,
    }
  }).pipe(Effect.withSpan("Worktree.build"))
}

const execIgnore = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  command: ChildProcess.Command,
) => command.pipe(spawner.exitCode, Effect.catchCause(Effect.logWarning))

const seedSetupScript = Effect.fnUntraced(function* (setupPath: string) {
  const fs = yield* FileSystem.FileSystem
  const pathService = yield* Path.Path

  if (yield* fs.exists(setupPath)) {
    return
  }

  yield* fs.makeDirectory(pathService.dirname(setupPath), {
    recursive: true,
  })
  yield* fs.writeFileString(setupPath, setupScriptTemplate)
  yield* fs.chmod(setupPath, 0o755)
})

export const setupWorktree = Effect.fnUntraced(function* (options: {
  readonly directory: string
  readonly exec: (
    template: TemplateStringsArray,
    ...args: Array<string | number | boolean>
  ) => Effect.Effect<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>
  readonly execShell: (
    command: string,
  ) => Effect.Effect<number, PlatformError.PlatformError>
  readonly getHookTemplateValues: Effect.Effect<HookTemplateValues>
  readonly repository: RepositoryInfo
}) {
  const fs = yield* FileSystem.FileSystem
  const hooks = yield* Hooks
  const pathService = yield* Path.Path
  const targetBranch = yield* getTargetBranch

  if (Option.isSome(targetBranch)) {
    const parsed = yield* resolveTargetBranch({
      repository: options.repository,
      targetBranch: targetBranch.value,
    })

    if (options.repository.kind === "git") {
      if (Option.isSome(parsed.remote)) {
        yield* options.exec`git fetch ${parsed.remote.value}`
      }
      const code = yield* options.exec`git checkout ${parsed.branchWithRemote}`
      if (code !== 0 && Option.isSome(parsed.remote)) {
        yield* options.exec`git checkout -b ${parsed.branch}`
        yield* options.exec`git push -u ${parsed.remote.value} ${parsed.branch}`
      }
    } else {
      if (Option.isSome(parsed.remote)) {
        yield* options.exec`jj git fetch --remote ${parsed.remote.value} --branch ${parsed.branch}`
      }
      yield* options.exec`jj new ${targetBranchToJjRevision(parsed)}`
    }
  }

  const usedHooksConfig = yield* hooks.executeHook({
    directory: options.directory,
    fallbackDirectory: options.repository.root,
    hookType: "post-create",
    runCommand: options.execShell,
    templateValues: yield* options.getHookTemplateValues,
  })

  if (usedHooksConfig) {
    return
  }

  const cwdSetupPath = pathService.resolve("scripts", "worktree-setup.sh")
  const worktreeSetupPath = pathService.join(
    options.directory,
    "scripts",
    "worktree-setup.sh",
  )

  yield* seedSetupScript(cwdSetupPath)

  const setupPath = (yield* fs.exists(worktreeSetupPath))
    ? worktreeSetupPath
    : cwdSetupPath

  yield* options.exec`${setupPath}`
})

const getTargetBranch = Effect.gen(function* () {
  const projectId = yield* CurrentProjectId
  const project = yield* projectById(projectId)
  if (Option.isNone(project)) {
    return Option.none<string>()
  }
  return project.value.targetBranch
})

const getCheckoutMode = Effect.gen(function* () {
  const projectId = yield* CurrentProjectId
  const project = yield* projectById(projectId)
  if (Option.isNone(project)) {
    return "worktree" satisfies ProjectCheckoutMode
  }
  return project.value.checkoutMode
})

const setupScriptTemplate = `#!/usr/bin/env bash
set -euo pipefail

pnpm install

# Seeded by lalph. Customize this to prepare new worktrees.
`

const makeHookEnv = (options: {
  readonly directory: string
  readonly githubRepo: string | undefined
  readonly mode: ProjectCheckoutMode
  readonly projectId: string
  readonly repository: RepositoryInfo
  readonly targetBranch: string | undefined
  readonly workspaceName: string
}) => ({
  ...process.env,
  ...(options.githubRepo ? { GH_REPO: options.githubRepo } : {}),
  LALPH_MAIN_WORKTREE_PATH: options.repository.root,
  LALPH_PROJECT_ID: options.projectId,
  LALPH_REPOSITORY_KIND: options.repository.kind,
  LALPH_TARGET_BRANCH: options.targetBranch ?? "",
  LALPH_WORKSPACE_NAME: options.workspaceName,
  LALPH_WORKTREE_MODE: options.mode,
  LALPH_WORKTREE_PATH: options.directory,
})

export const makeExecHelpers = Effect.fnUntraced(function* (options: {
  readonly directory: string
  readonly githubRepo: string | undefined
  readonly mode: ProjectCheckoutMode
  readonly projectId: string
  readonly repository: RepositoryInfo
  readonly targetBranch: string | undefined
}) {
  const fs = yield* FileSystem.FileSystem
  const pathService = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const hooks = yield* Hooks
  const provide = Effect.provideService(
    ChildProcessSpawner.ChildProcessSpawner,
    spawner,
  )

  const currentBranch = (dir: string) =>
    ChildProcess.make({
      cwd: dir,
    })`git branch --show-current`.pipe(
      spawner.string,
      provide,
      Effect.flatMap((output) =>
        Option.some(output.trim()).pipe(
          Option.filter((b) => b.length > 0),
          Effect.fromOption,
        ),
      ),
    )

  const withJjWorkspaceReady = <A>(
    dir: string,
    effect: Effect.Effect<A, PlatformError.PlatformError>,
  ) =>
    effect.pipe(
      Effect.catchCause(() =>
        ChildProcess.make({
          cwd: dir,
          stderr: "inherit",
          stdout: "inherit",
        })`jj workspace update-stale`.pipe(
          spawner.exitCode,
          provide,
          Effect.flatMap(() => effect),
        ),
      ),
    )

  const currentJjWorkspaceName = (dir: string) =>
    withJjWorkspaceReady(
      dir,
      ChildProcess.make({
        cwd: dir,
      })`jj workspace list --color ${"never"} -T ${'if(target.current_working_copy(), name ++ "\\n", "")'}`.pipe(
        spawner.string,
        provide,
        Effect.map((output) => output.trim()),
        Effect.map((workspaceName) =>
          workspaceName.length > 0
            ? workspaceName
            : options.mode === "worktree"
              ? makeJjWorkspaceName(pathService.basename(dir))
              : "",
        ),
      ),
    )

  const currentWorkspaceName =
    options.repository.kind === "git"
      ? currentBranch(options.directory).pipe(
          Effect.catchCause(() => Effect.succeed("")),
        )
      : currentJjWorkspaceName(options.directory).pipe(
          Effect.catchCause(() => Effect.succeed("")),
        )

  const hookContext = Effect.gen(function* () {
    const workspaceName = yield* currentWorkspaceName
    return {
      env: makeHookEnv({
        ...options,
        workspaceName,
      }),
      templateValues: {
        main_worktree_path: options.repository.root,
        project_id: options.projectId,
        repository_kind: options.repository.kind,
        target_branch: options.targetBranch,
        workspace: workspaceName,
        worktree_path: options.directory,
      } satisfies HookTemplateValues,
    } as const
  })

  const withRepositoryEnv = Effect.fnUntraced(function* (
    command: ChildProcess.Command,
  ) {
    const context = yield* hookContext
    return ChildProcess.setEnv(command, context.env)
  })

  const exec = (
    template: TemplateStringsArray,
    ...args: Array<string | number | boolean>
  ) =>
    ChildProcess.make({
      cwd: options.directory,
      stderr: "inherit",
      stdout: "inherit",
    })(template, ...args).pipe(
      withRepositoryEnv,
      Effect.flatMap((command) => command.pipe(spawner.exitCode, provide)),
    )

  const execString = (
    template: TemplateStringsArray,
    ...args: Array<string | number | boolean>
  ) =>
    ChildProcess.make({
      cwd: options.directory,
    })(template, ...args).pipe(
      withRepositoryEnv,
      Effect.flatMap((command) => command.pipe(spawner.string, provide)),
    )

  const execShell = (command: string) =>
    ChildProcess.make(process.env.SHELL || "/bin/bash", ["-lc", command], {
      cwd: options.directory,
      stderr: "inherit",
      stdout: "inherit",
    }).pipe(
      withRepositoryEnv,
      Effect.flatMap((command) => command.pipe(spawner.exitCode, provide)),
    )

  const getHookTemplateValues = hookContext.pipe(
    Effect.map(({ templateValues }) => templateValues),
  )

  const viewPrState = (prNumber?: number) =>
    execString`gh pr view ${prNumber ? prNumber : ""} --json number,state`.pipe(
      Effect.flatMap(Schema.decodeEffect(PrState)),
      Effect.option,
      provide,
    )

  const runPostSwitchHooks = Effect.fnUntraced(function* (method: string) {
    yield* hooks
      .executeHook({
        directory: options.directory,
        fallbackDirectory: options.repository.root,
        hookType: "post-switch",
        runCommand: execShell,
        templateValues: yield* getHookTemplateValues,
      })
      .pipe(Effect.provideService(FileSystem.FileSystem, fs))
      .pipe(
        Effect.catchIf(
          (error): error is HookCommandFailedError =>
            error instanceof HookCommandFailedError,
          (error) =>
            Effect.fail(
              PlatformError.badArgument({
                cause: error,
                description: error.message,
                method,
                module: "Worktree",
              }),
            ),
        ),
        Effect.catchIf(
          (error): error is HooksConfigParseError =>
            error instanceof HooksConfigParseError,
          (error) =>
            Effect.fail(
              PlatformError.badArgument({
                cause: error,
                description: `Failed to load post-switch hooks: ${error.message}`,
                method,
                module: "Worktree",
              }),
            ),
        ),
        Effect.catchIf(Schema.isSchemaError, (error) =>
          Effect.fail(
            PlatformError.badArgument({
              cause: error,
              description: `Invalid hooks configuration: ${error.message}`,
              method,
              module: "Worktree",
            }),
          ),
        ),
      )
  })

  const checkoutPr = Effect.fnUntraced(function* (prNumber: number) {
    if (options.repository.kind === "git") {
      const exitCode = yield* exec`gh pr checkout ${prNumber}`
      if (exitCode !== 0) {
        return exitCode
      }
      yield* runPostSwitchHooks("checkoutPr")
      return exitCode
    }

    const pr =
      yield* execString`gh pr view ${prNumber} --json headRefName`.pipe(
        Effect.flatMap(Schema.decodeEffect(PrHeadRef)),
      )

    yield* exec`jj git fetch --remote ${"origin"} --branch ${pr.headRefName}`
    const trackCode =
      yield* exec`jj bookmark track ${pr.headRefName} --remote ${"origin"}`

    if (trackCode === 0) {
      const exitCode = yield* exec`jj new ${pr.headRefName}`
      if (exitCode !== 0) {
        return exitCode
      }
      yield* runPostSwitchHooks("checkoutPr")
      return exitCode
    }

    const exitCode = yield* exec`jj new ${`${pr.headRefName}@origin`}`
    if (exitCode !== 0) {
      return exitCode
    }
    yield* runPostSwitchHooks("checkoutPr")
    return exitCode
  })

  const execWithOutput = (options: { readonly cliAgent: AnyCliAgent }) =>
    Effect.fnUntraced(function* (command: ChildProcess.Command) {
      const handle = yield* withRepositoryEnv(command).pipe(
        Effect.flatMap((command) => provide(command.asEffect())),
      )

      yield* handle.all.pipe(
        Stream.decodeText(),
        options.cliAgent.outputTransformer
          ? options.cliAgent.outputTransformer
          : identity,
        Stream.runForEachArray((output) => {
          for (const chunk of output) {
            process.stdout.write(chunk)
          }
          return Effect.void
        }),
      )
      return yield* handle.exitCode
    }, Effect.scoped)

  const execWithWorkerOutput = (options: { readonly cliAgent: AnyCliAgent }) =>
    Effect.fnUntraced(function* (command: ChildProcess.Command) {
      const registry = yield* AtomRegistry.AtomRegistry
      const worker = yield* CurrentWorkerState

      const handle = yield* withRepositoryEnv(command).pipe(
        Effect.flatMap((command) => provide(command.asEffect())),
      )

      yield* handle.all.pipe(
        Stream.decodeText(),
        options.cliAgent.outputTransformer
          ? options.cliAgent.outputTransformer
          : identity,
        Stream.runForEachArray((output) => {
          for (const chunk of output) {
            process.stdout.write(chunk)
          }
          registry.update(
            worker.output,
            flow(
              Chunk.appendAll(Chunk.fromArrayUnsafe(output)),
              Chunk.takeRight(constWorkerMaxOutputChunks),
            ),
          )
          return Effect.void
        }),
      )
      return yield* handle.exitCode
    }, Effect.scoped)

  const execWithStallTimeout = (options: {
    readonly stallTimeout: Duration.Duration
    readonly cliAgent: AnyCliAgent
  }) =>
    Effect.fnUntraced(function* (command: ChildProcess.Command) {
      const registry = yield* AtomRegistry.AtomRegistry
      const worker = yield* CurrentWorkerState

      const handle = yield* withRepositoryEnv(command).pipe(
        Effect.flatMap((command) => provide(command.asEffect())),
      )

      yield* handle.all.pipe(
        Stream.decodeText(),
        options.cliAgent.outputTransformer
          ? options.cliAgent.outputTransformer
          : identity,
        withStallTimeout(options.stallTimeout),
        Stream.runForEachArray((output) => {
          for (const chunk of output) {
            process.stdout.write(chunk)
          }
          registry.update(
            worker.output,
            flow(
              Chunk.appendAll(Chunk.fromArrayUnsafe(output)),
              Chunk.takeRight(constWorkerMaxOutputChunks),
            ),
          )
          return Effect.void
        }),
      )
      return yield* handle.exitCode
    }, Effect.scoped)

  const jjWorkingCopyEmpty = (dir: string) =>
    withJjWorkspaceReady(
      dir,
      ChildProcess.make({
        cwd: dir,
      })`jj log -r ${"@"} --no-graph -T ${'if(empty, "true", "false") ++ "\\n"'}`.pipe(
        spawner.string,
        provide,
        Effect.map((output) => output.trim() === "true"),
      ),
    )

  return {
    checkoutPr,
    currentBranch,
    exec,
    execShell,
    execString,
    execWithOutput,
    execWithStallTimeout,
    execWithWorkerOutput,
    getHookTemplateValues,
    jjWorkingCopyEmpty,
    runPostSwitchHooks,
    viewPrState,
    withRepositoryEnv,
  } as const
})

const PrState = Schema.fromJsonString(
  Schema.Struct({
    number: Schema.Finite,
    state: Schema.String,
  }),
)

const PrHeadRef = Schema.fromJsonString(
  Schema.Struct({
    headRefName: Schema.String,
  }),
)
