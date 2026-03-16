import { Data, Effect, FileSystem, Option, Path, pipe } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { parseBranch } from "./git.ts"

export type VcsKind = "git" | "jj"

export type RepositoryInfo = {
  readonly kind: VcsKind
  readonly root: string
}

export type ResolvedTargetBranch = {
  readonly branch: string
  readonly branchWithRemote: string
  readonly remote: Option.Option<string>
}

export type RemoteUrl = {
  readonly name: string
  readonly url: string
}

export type RepositoryWorkspace =
  | {
      readonly kind: "git"
      readonly path: string
      readonly current: boolean
      readonly default: boolean
      readonly branch: string | undefined
      readonly branchRef: string | undefined
    }
  | {
      readonly kind: "jj"
      readonly path: string
      readonly current: boolean
      readonly default: boolean
      readonly workspaceName: string
    }

export class RepositoryWorkspaceNotFound extends Data.TaggedError(
  "RepositoryWorkspaceNotFound",
)<{
  readonly selector: string
}> {
  readonly message = `No worktree or workspace matches "${this.selector}"`
}

export class RepositoryWorkspaceAmbiguous extends Data.TaggedError(
  "RepositoryWorkspaceAmbiguous",
)<{
  readonly selector: string
  readonly matches: ReadonlyArray<string>
}> {
  readonly message = `Multiple worktrees or workspaces match "${this.selector}": ${this.matches.join(", ")}`
}

export class RepositoryWorkspaceIsCurrent extends Data.TaggedError(
  "RepositoryWorkspaceIsCurrent",
)<{
  readonly workspace: RepositoryWorkspace
}> {
  readonly message = `Cannot remove the current ${this.workspace.kind === "git" ? "worktree" : "workspace"}: ${formatRepositoryWorkspace(this.workspace)}`
}

export class RepositoryWorkspaceIsDefault extends Data.TaggedError(
  "RepositoryWorkspaceIsDefault",
)<{
  readonly workspace: RepositoryWorkspace
}> {
  readonly message = `Cannot remove the default ${this.workspace.kind === "git" ? "worktree" : "workspace"}: ${formatRepositoryWorkspace(this.workspace)}`
}

export class RepositoryWorkspaceRemoveError extends Data.TaggedError(
  "RepositoryWorkspaceRemoveError",
)<{
  readonly workspace: RepositoryWorkspace
  readonly exitCode: number
}> {
  readonly message = `Failed to remove ${formatRepositoryWorkspace(this.workspace)} (exit code ${this.exitCode})`
}

export const findRepository = Effect.fnUntraced(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem
  const pathService = yield* Path.Path

  let current = pathService.resolve(cwd)
  while (true) {
    const inJjRoot = yield* fs.exists(pathService.join(current, ".jj"))
    if (inJjRoot) {
      return Option.some<RepositoryInfo>({
        kind: "jj",
        root: current,
      })
    }

    const inGitRoot = yield* fs.exists(pathService.join(current, ".git"))
    if (inGitRoot) {
      return Option.some<RepositoryInfo>({
        kind: "git",
        root: current,
      })
    }

    const parent = pathService.dirname(current)
    if (parent === current) {
      return Option.none<RepositoryInfo>()
    }
    current = parent
  }
})

export const getCurrentRepository = Effect.gen(function* () {
  const pathService = yield* Path.Path
  const cwd = pathService.resolve(".")
  return yield* pipe(
    findRepository(cwd),
    Effect.map(
      Option.getOrElse(
        (): RepositoryInfo => ({
          kind: "git",
          root: cwd,
        }),
      ),
    ),
  )
})

export const makeJjWorkspaceName = (directory: string) =>
  `lalph-${directory.replaceAll(/[^a-zA-Z0-9-]/g, "-")}`

export const resolveTargetBranch = Effect.fnUntraced(function* (options: {
  readonly repository: RepositoryInfo
  readonly targetBranch: string
}) {
  const remotes = yield* listGitRemotes(options.repository)
  const remoteNames = new Set(remotes.map((remote) => remote.name))
  const parts = options.targetBranch.split("/")
  const maybeRemote = parts[0]

  if (maybeRemote && parts.length > 1 && remoteNames.has(maybeRemote)) {
    const parsed = parseBranch(options.targetBranch)
    return {
      branch: parsed.branch,
      branchWithRemote: parsed.branchWithRemote,
      remote: Option.some(parsed.remote),
    } satisfies ResolvedTargetBranch
  }

  return {
    branch: options.targetBranch,
    branchWithRemote: options.targetBranch,
    remote: Option.none(),
  } satisfies ResolvedTargetBranch
})

export const targetBranchToJjRevision = (targetBranch: ResolvedTargetBranch) =>
  Option.match(targetBranch.remote, {
    onNone: () => targetBranch.branch,
    onSome: (remote) => `${targetBranch.branch}@${remote}`,
  })

export const targetBranchToJjBookmark = (targetBranch: ResolvedTargetBranch) =>
  targetBranch.branch

const parseGitRemoteConfig = (output: string): ReadonlyArray<RemoteUrl> =>
  output
    .split("\n")
    .map((line) => line.trim())
    .flatMap((line) => {
      if (line.length === 0) {
        return []
      }
      const match = /^remote\.([^.]+)\.url\s+(.+)$/.exec(line)
      if (!match) {
        return []
      }
      return [{ name: match[1]!, url: match[2]! }] as const
    })

const parseJjRemoteList = (output: string): ReadonlyArray<RemoteUrl> =>
  output
    .split("\n")
    .map((line) => line.trim())
    .flatMap((line) => {
      if (line.length === 0) {
        return []
      }

      const match = /^(\S+)\s+(.+)$/.exec(line)
      if (!match) {
        return []
      }

      return [{ name: match[1]!, url: match[2]! }] as const
    })

const parseGitWorktreeList = (output: string) =>
  output
    .trim()
    .split("\n\n")
    .flatMap((entry) => {
      if (entry.trim().length === 0) {
        return []
      }

      let path: string | undefined = undefined
      let branchRef: string | undefined = undefined

      for (const line of entry.split("\n")) {
        if (line.startsWith("worktree ")) {
          path = line.slice("worktree ".length)
        } else if (line.startsWith("branch ")) {
          branchRef = line.slice("branch ".length)
        }
      }

      if (!path) {
        return []
      }

      return [
        {
          branch: branchRef?.replace(/^refs\/heads\//, ""),
          branchRef,
          path,
        },
      ] as const
    })

const parseJjWorkspaceList = (output: string) =>
  output
    .split("\n")
    .map((line) => line.trim())
    .flatMap((line) => {
      if (line.length === 0) {
        return []
      }

      const [workspaceName, currentFlag] = line.split("|")
      if (!workspaceName) {
        return []
      }

      return [
        {
          current: currentFlag === "current",
          workspaceName,
        },
      ] as const
    })

export const listGitRemotes = Effect.fnUntraced(function* (
  repository: RepositoryInfo,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  const command =
    repository.kind === "git"
      ? ChildProcess.make(
          "git",
          [
            "-C",
            repository.root,
            "config",
            "--get-regexp",
            "^remote\\..*\\.url$",
          ],
          {
            stderr: "pipe",
          },
        )
      : ChildProcess.make("jj", ["git", "remote", "list"], {
          cwd: repository.root,
          stderr: "pipe",
        })

  return yield* command.pipe(
    spawner.string,
    Effect.map(
      repository.kind === "git" ? parseGitRemoteConfig : parseJjRemoteList,
    ),
    Effect.catchCause(() => Effect.succeed([])),
  )
})

export const listRepositoryWorkspaces = Effect.fnUntraced(function* (
  repository: RepositoryInfo,
) {
  const fs = yield* FileSystem.FileSystem
  const pathService = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const currentRoot = pathService.resolve(repository.root)

  if (repository.kind === "git") {
    const output = yield* ChildProcess.make(
      "git",
      ["-C", repository.root, "worktree", "list", "--porcelain"],
      {
        stderr: "pipe",
      },
    ).pipe(spawner.string)

    return yield* Effect.forEach(
      parseGitWorktreeList(output),
      ({ branch, branchRef, path }) =>
        Effect.gen(function* () {
          const gitMetadata = yield* fs
            .stat(pathService.join(path, ".git"))
            .pipe(Effect.option)

          return {
            kind: "git",
            path,
            current: pathService.resolve(path) === currentRoot,
            default:
              Option.isSome(gitMetadata) &&
              gitMetadata.value.type === "Directory",
            branch,
            branchRef,
          } satisfies RepositoryWorkspace
        }),
      { concurrency: 4 },
    )
  }

  const output = yield* ChildProcess.make({
    cwd: repository.root,
    stderr: "pipe",
  })`jj workspace list --color ${"never"} -T ${'name ++ "|" ++ if(target.current_working_copy(), "current", "") ++ "\\n"'}`.pipe(
    spawner.string,
  )

  const workspaces = parseJjWorkspaceList(output)

  return yield* Effect.forEach(
    workspaces,
    ({ current, workspaceName }) =>
      ChildProcess.make({
        cwd: repository.root,
        stderr: "pipe",
      })`jj workspace root --name ${workspaceName}`.pipe(
        spawner.string,
        Effect.map(
          (path): RepositoryWorkspace => ({
            kind: "jj",
            path: path.trim(),
            current,
            default: workspaceName === "default",
            workspaceName,
          }),
        ),
      ),
    { concurrency: 4 },
  )
})

const workspaceSelectors = (
  pathService: Path.Path,
  workspace: RepositoryWorkspace,
) => {
  const selectors = [
    workspace.path,
    pathService.resolve(workspace.path),
    pathService.basename(workspace.path),
  ]

  if (workspace.kind === "git") {
    if (workspace.branch) {
      selectors.push(workspace.branch)
    }
    if (workspace.branchRef) {
      selectors.push(workspace.branchRef)
    }
  } else {
    selectors.push(workspace.workspaceName)
  }

  return selectors
}

const selectorLooksLikePath = (selector: string) =>
  selector.startsWith("/") ||
  selector.startsWith(".") ||
  selector.includes("/") ||
  selector.includes("\\")

const isProtectedRepositoryWorkspace = (workspace: RepositoryWorkspace) =>
  workspace.default

export const resolveRepositoryWorkspace = Effect.fnUntraced(function* (
  repository: RepositoryInfo,
  selector: string,
) {
  const pathService = yield* Path.Path
  const workspaces = yield* listRepositoryWorkspaces(repository)
  const trimmedSelector = selector.trim()
  const resolvedSelector = selectorLooksLikePath(trimmedSelector)
    ? pathService.resolve(trimmedSelector)
    : undefined

  const matches = workspaces.filter((workspace) => {
    const selectors = workspaceSelectors(pathService, workspace)
    if (selectors.includes(trimmedSelector)) {
      return true
    }
    return (
      resolvedSelector !== undefined && selectors.includes(resolvedSelector)
    )
  })

  if (matches.length === 0) {
    return yield* new RepositoryWorkspaceNotFound({
      selector: trimmedSelector,
    })
  }

  if (matches.length > 1) {
    return yield* new RepositoryWorkspaceAmbiguous({
      selector: trimmedSelector,
      matches: matches.map(formatRepositoryWorkspace),
    })
  }

  return matches[0]!
})

const removeListedRepositoryWorkspace = Effect.fnUntraced(function* (
  repository: RepositoryInfo,
  workspace: RepositoryWorkspace,
) {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  if (workspace.current) {
    return yield* new RepositoryWorkspaceIsCurrent({ workspace })
  }

  if (isProtectedRepositoryWorkspace(workspace)) {
    return yield* new RepositoryWorkspaceIsDefault({ workspace })
  }

  if (workspace.kind === "git") {
    const exitCode = yield* ChildProcess.make(
      "git",
      ["-C", repository.root, "worktree", "remove", "--force", workspace.path],
      {
        stderr: "inherit",
        stdout: "inherit",
      },
    ).pipe(spawner.exitCode)

    if (exitCode !== 0) {
      return yield* new RepositoryWorkspaceRemoveError({
        workspace,
        exitCode,
      })
    }

    return workspace
  }

  const forgetCode = yield* ChildProcess.make({
    cwd: repository.root,
    stderr: "inherit",
    stdout: "inherit",
  })`jj workspace forget ${workspace.workspaceName}`.pipe(spawner.exitCode)

  if (forgetCode !== 0) {
    return yield* new RepositoryWorkspaceRemoveError({
      workspace,
      exitCode: forgetCode,
    })
  }

  if (yield* fs.exists(workspace.path)) {
    yield* fs.remove(workspace.path, { recursive: true })
  }

  return workspace
})

export const removeRepositoryWorkspace = Effect.fnUntraced(function* (
  repository: RepositoryInfo,
  selector: string,
) {
  const workspace = yield* resolveRepositoryWorkspace(repository, selector)
  return yield* removeListedRepositoryWorkspace(repository, workspace)
})

export const pruneRepositoryWorkspaces = Effect.fnUntraced(function* (
  repository: RepositoryInfo,
) {
  const fs = yield* FileSystem.FileSystem
  const workspaces = yield* listRepositoryWorkspaces(repository)
  const stale: Array<RepositoryWorkspace> = []

  for (const workspace of workspaces) {
    if (workspace.current || workspace.default) {
      continue
    }
    if (!(yield* fs.exists(workspace.path))) {
      stale.push(workspace)
    }
  }

  const removed: Array<RepositoryWorkspace> = []
  for (const workspace of stale) {
    removed.push(yield* removeListedRepositoryWorkspace(repository, workspace))
  }

  return removed
})

export const formatRepositoryWorkspace = (workspace: RepositoryWorkspace) => {
  const marker = workspace.current ? "*" : " "
  if (workspace.kind === "git") {
    const label = workspace.default
      ? workspace.branch === undefined
        ? "default"
        : workspace.branch === "main" || workspace.branch === "master"
          ? "default"
          : `default (${workspace.branch})`
      : (workspace.branch ?? "detached")
    return `${marker} ${label} -> ${workspace.path}`
  }
  return `${marker} ${workspace.workspaceName} -> ${workspace.path}`
}

export const parseGithubRepositoryFromUrl = (url: string) => {
  const normalized = url.trim().replace(/\/+$/, "")
  const patterns = [
    /^git@github\.com:(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/,
    /^ssh:\/\/git@github\.com\/(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/,
    /^https?:\/\/github\.com\/(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/,
  ] as const

  for (const pattern of patterns) {
    const match = pattern.exec(normalized)
    if (!match?.groups) {
      continue
    }
    return Option.some(
      `${match.groups["owner"]!}/${match.groups["repo"]!}`.toLowerCase(),
    )
  }

  return Option.none<string>()
}

export const getGithubRepository = Effect.fnUntraced(function* (
  repository: RepositoryInfo,
) {
  const remotes = yield* listGitRemotes(repository)
  const prioritized = remotes
    .filter((remote) => remote.name === "origin")
    .concat(remotes.filter((remote) => remote.name !== "origin"))

  for (const remote of prioritized) {
    const repository = parseGithubRepositoryFromUrl(remote.url)
    if (Option.isSome(repository)) {
      return repository
    }
  }

  return Option.none<string>()
})
