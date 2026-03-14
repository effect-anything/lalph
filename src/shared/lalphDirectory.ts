import { Effect, FileSystem, Option, Path } from "effect"

const findProjectRoot = Effect.fnUntraced(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem
  const pathService = yield* Path.Path

  let current = cwd
  while (true) {
    const inGitRoot = yield* fs.exists(pathService.join(current, ".git"))
    if (inGitRoot) {
      return Option.some(current)
    }

    const inJjRoot = yield* fs.exists(pathService.join(current, ".jj"))
    if (inJjRoot) {
      return Option.some(current)
    }

    const parent = pathService.dirname(current)
    if (parent === current) {
      return Option.none<string>()
    }
    current = parent
  }
})

export const resolveLalphDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const pathService = yield* Path.Path
  const cwd = pathService.resolve(".")

  const inCwd = yield* fs.exists(pathService.join(cwd, ".lalph"))
  if (inCwd) {
    return cwd
  }

  const projectRoot = yield* findProjectRoot(cwd)
  if (Option.isSome(projectRoot)) {
    const inProjectRoot = yield* fs.exists(
      pathService.join(projectRoot.value, ".lalph"),
    )
    if (inProjectRoot) {
      return projectRoot.value
    }
  }

  return cwd
})

const syncedLalphEntries = ["config", "projects", "hooks.yml"] as const

const copyLalphEntry = Effect.fnUntraced(function* (options: {
  readonly sourcePath: string
  readonly targetPath: string
}) {
  const fs = yield* FileSystem.FileSystem

  yield* fs.remove(options.targetPath, {
    force: true,
    recursive: true,
  })
  yield* fs.copy(options.sourcePath, options.targetPath, {
    overwrite: true,
  })
})

export const syncLalphDirectory = Effect.fnUntraced(function* (options: {
  readonly sourceDirectory: string
  readonly targetDirectory: string
}) {
  const fs = yield* FileSystem.FileSystem
  const pathService = yield* Path.Path
  const sourceDirectory = pathService.resolve(options.sourceDirectory)
  const targetDirectory = pathService.resolve(options.targetDirectory)

  if (sourceDirectory === targetDirectory) {
    return
  }

  const sourceLalphDirectory = pathService.join(sourceDirectory, ".lalph")
  if (!(yield* fs.exists(sourceLalphDirectory))) {
    return
  }

  const targetLalphDirectory = pathService.join(targetDirectory, ".lalph")
  yield* fs.makeDirectory(targetLalphDirectory, { recursive: true })

  for (const entry of syncedLalphEntries) {
    const sourcePath = pathService.join(sourceLalphDirectory, entry)
    if (!(yield* fs.exists(sourcePath))) {
      continue
    }

    yield* copyLalphEntry({
      sourcePath,
      targetPath: pathService.join(targetLalphDirectory, entry),
    })
  }
})
