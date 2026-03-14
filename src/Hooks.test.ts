import assert from "node:assert/strict"
import test from "node:test"
import { Effect, FileSystem, Option, Path, Schema } from "effect"
import { HookCommandFailedError, Hooks, interpolateTemplate } from "./Hooks.ts"
import { HooksConfig } from "./domain/Hooks.ts"
import { PlatformServices } from "./shared/platform.ts"

test("HooksConfig decodes valid sections", () => {
  const config = Schema.decodeUnknownSync(HooksConfig)({
    hooks: {
      "post-create": {
        deps: "pnpm install",
      },
      "pre-merge": {
        validate: "pnpm check",
      },
    },
  })

  assert.deepEqual(config, {
    hooks: {
      "post-create": {
        deps: "pnpm install",
      },
      "pre-merge": {
        validate: "pnpm check",
      },
    },
  })
})

test("HooksConfig rejects non-string hook commands", () => {
  assert.throws(() =>
    Schema.decodeUnknownSync(HooksConfig)({
      hooks: {
        "post-create": {
          deps: 123,
        },
      },
    }),
  )
})

test("interpolateTemplate replaces known variables and blanks missing ones", () => {
  const result = interpolateTemplate(
    "cp {{ main_worktree_path }}/node_modules . && echo {{ workspace }} {{ missing }} {{ target_branch }}",
    {
      main_worktree_path: "/repo/main",
      workspace: "AUT-63-hooks",
      target_branch: undefined,
    },
  )

  assert.equal(result, "cp /repo/main/node_modules . && echo AUT-63-hooks  ")
})

test("Hooks.loadConfig returns none when hooks.yml is missing", async () => {
  const directory = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      return yield* fs.makeTempDirectory()
    }).pipe(Effect.provide(PlatformServices)),
  )

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const hooks = yield* Hooks
      return yield* hooks.loadConfig(directory)
    }).pipe(Effect.provide(Hooks.layer), Effect.provide(PlatformServices)),
  )

  assert.equal(Option.isNone(result), true)
})

test("Hooks.loadConfig parses hooks.yml from the worktree", async () => {
  const directory = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const pathService = yield* Path.Path
      const directory = yield* fs.makeTempDirectory()
      const configPath = pathService.join(directory, ".lalph", "hooks.yml")

      yield* fs.makeDirectory(pathService.dirname(configPath), {
        recursive: true,
      })
      yield* fs.writeFileString(
        configPath,
        `hooks:
  post-create:
    deps: pnpm install
  post-switch:
    notify: echo "ready"
`,
      )

      return directory
    }).pipe(Effect.provide(PlatformServices)),
  )

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const hooks = yield* Hooks
      return yield* hooks.loadConfig(directory)
    }).pipe(Effect.provide(Hooks.layer), Effect.provide(PlatformServices)),
  )

  assert.equal(Option.isSome(result), true)
  if (Option.isNone(result)) {
    return
  }

  assert.deepEqual(result.value, {
    hooks: {
      "post-create": {
        deps: "pnpm install",
      },
      "post-switch": {
        notify: 'echo "ready"',
      },
    },
  })
})

test("Hooks.loadConfig falls back to the main worktree hooks.yml", async () => {
  const { directory, mainDirectory } = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const pathService = yield* Path.Path
      const mainDirectory = yield* fs.makeTempDirectory()
      const directory = yield* fs.makeTempDirectory()
      const configPath = pathService.join(mainDirectory, ".lalph", "hooks.yml")

      yield* fs.makeDirectory(pathService.dirname(configPath), {
        recursive: true,
      })
      yield* fs.writeFileString(
        configPath,
        `hooks:
  pre-merge:
    validate: pnpm check
`,
      )

      return { directory, mainDirectory } as const
    }).pipe(Effect.provide(PlatformServices)),
  )

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const hooks = yield* Hooks
      return yield* hooks.loadConfig(directory, mainDirectory)
    }).pipe(Effect.provide(Hooks.layer), Effect.provide(PlatformServices)),
  )

  assert.equal(Option.isSome(result), true)
  if (Option.isNone(result)) {
    return
  }

  assert.deepEqual(result.value, {
    hooks: {
      "pre-merge": {
        validate: "pnpm check",
      },
    },
  })
})

test("Hooks.executeHook sorts commands and interpolates template values", async () => {
  const directory = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const pathService = yield* Path.Path
      const directory = yield* fs.makeTempDirectory()
      const configPath = pathService.join(directory, ".lalph", "hooks.yml")

      yield* fs.makeDirectory(pathService.dirname(configPath), {
        recursive: true,
      })
      yield* fs.writeFileString(
        configPath,
        `hooks:
  post-create:
    z-last: echo "{{ worktree_path }}"
    a-first: echo "{{ workspace }}:{{ main_worktree_path }}"
`,
      )

      return directory
    }).pipe(Effect.provide(PlatformServices)),
  )

  const commands: Array<string> = []

  const usedConfig = await Effect.runPromise(
    Effect.gen(function* () {
      const hooks = yield* Hooks
      return yield* hooks.executeHook({
        directory,
        hookType: "post-create",
        runCommand: (command) => {
          commands.push(command)
          return Effect.succeed(0)
        },
        templateValues: {
          main_worktree_path: "/repo/main",
          worktree_path: "/repo/worktree",
          workspace: "AUT-70-hooks",
        },
      })
    }).pipe(Effect.provide(Hooks.layer), Effect.provide(PlatformServices)),
  )

  assert.equal(usedConfig, true)
  assert.deepEqual(commands, [
    'echo "AUT-70-hooks:/repo/main"',
    'echo "/repo/worktree"',
  ])
})

test("Hooks.resolveHook returns sorted dry-run commands", async () => {
  const directory = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const pathService = yield* Path.Path
      const directory = yield* fs.makeTempDirectory()
      const configPath = pathService.join(directory, ".lalph", "hooks.yml")

      yield* fs.makeDirectory(pathService.dirname(configPath), {
        recursive: true,
      })
      yield* fs.writeFileString(
        configPath,
        `hooks:
  pre-merge:
    z-last: echo "{{ worktree_path }}"
    a-first: echo "{{ target_branch }}:{{ project_id }}"
`,
      )

      return directory
    }).pipe(Effect.provide(PlatformServices)),
  )

  const resolved = await Effect.runPromise(
    Effect.gen(function* () {
      const hooks = yield* Hooks
      return yield* hooks.resolveHook({
        directory,
        hookType: "pre-merge",
        templateValues: {
          project_id: "AUT-73",
          target_branch: "origin/master",
          worktree_path: "/repo/worktree",
        },
      })
    }).pipe(Effect.provide(Hooks.layer), Effect.provide(PlatformServices)),
  )

  assert.equal(Option.isSome(resolved), true)
  if (Option.isNone(resolved)) {
    return
  }

  assert.deepEqual(resolved.value, [
    {
      command: 'echo "{{ target_branch }}:{{ project_id }}"',
      hookName: "a-first",
      interpolatedCommand: 'echo "origin/master:AUT-73"',
    },
    {
      command: 'echo "{{ worktree_path }}"',
      hookName: "z-last",
      interpolatedCommand: 'echo "/repo/worktree"',
    },
  ])
})

test("Hooks.executeHook fails when a command exits non-zero", async () => {
  const directory = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const pathService = yield* Path.Path
      const directory = yield* fs.makeTempDirectory()
      const configPath = pathService.join(directory, ".lalph", "hooks.yml")

      yield* fs.makeDirectory(pathService.dirname(configPath), {
        recursive: true,
      })
      yield* fs.writeFileString(
        configPath,
        `hooks:
  post-create:
    fail: exit 7
`,
      )

      return directory
    }).pipe(Effect.provide(PlatformServices)),
  )

  await assert.rejects(
    Effect.runPromise(
      Effect.gen(function* () {
        const hooks = yield* Hooks
        return yield* hooks.executeHook({
          directory,
          hookType: "post-create",
          runCommand: () => Effect.succeed(7),
          templateValues: {},
        })
      }).pipe(Effect.provide(Hooks.layer), Effect.provide(PlatformServices)),
    ),
    (error: unknown) =>
      error instanceof HookCommandFailedError &&
      error.hookType === "post-create" &&
      error.hookName === "fail" &&
      error.exitCode === 7,
  )
})
