import assert from "node:assert/strict"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Effect } from "effect"
import { PlatformServices } from "./platform.ts"
import { resolveLalphDirectory, syncLalphDirectory } from "./lalphDirectory.ts"

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(
    Effect.provide(effect, PlatformServices) as Effect.Effect<A, E, never>,
  )

const withCurrentDirectory = async <A>(
  directory: string,
  run: () => Promise<A>,
) => {
  const previousDirectory = process.cwd()
  process.chdir(directory)
  try {
    return await run()
  } finally {
    process.chdir(previousDirectory)
  }
}

test("syncLalphDirectory copies shared config, projects, and hooks.yml", async (t) => {
  const sourceDirectory = mkdtempSync(join(tmpdir(), "lalph-shared-source-"))
  const targetDirectory = mkdtempSync(join(tmpdir(), "lalph-shared-target-"))
  t.after(() => {
    rmSync(sourceDirectory, { force: true, recursive: true })
    rmSync(targetDirectory, { force: true, recursive: true })
  })

  mkdirSync(join(sourceDirectory, ".lalph", "config"), { recursive: true })
  mkdirSync(join(sourceDirectory, ".lalph", "projects"), { recursive: true })
  writeFileSync(join(sourceDirectory, ".lalph", "hooks.yml"), "hooks: {}\n")
  writeFileSync(join(sourceDirectory, ".lalph", "config", "token"), "abc\n")
  writeFileSync(join(sourceDirectory, ".lalph", "projects", "moo"), "project\n")

  mkdirSync(join(targetDirectory, ".lalph"), { recursive: true })
  writeFileSync(join(targetDirectory, ".lalph", "hooks.yml"), "stale\n")

  await run(
    syncLalphDirectory({
      sourceDirectory,
      targetDirectory,
    }),
  )

  assert.equal(
    readFileSync(join(targetDirectory, ".lalph", "config", "token"), "utf8"),
    "abc\n",
  )
  assert.equal(
    readFileSync(join(targetDirectory, ".lalph", "projects", "moo"), "utf8"),
    "project\n",
  )

  assert.equal(
    readFileSync(join(targetDirectory, ".lalph", "hooks.yml"), "utf8"),
    "hooks: {}\n",
  )
})

test("resolveLalphDirectory finds the project root in jj repositories", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "lalph-jj-root-"))
  const nestedDirectory = join(directory, "nested", "child")
  t.after(() => {
    rmSync(directory, { force: true, recursive: true })
  })

  mkdirSync(join(directory, ".jj"), { recursive: true })
  mkdirSync(join(directory, ".lalph"), { recursive: true })
  mkdirSync(nestedDirectory, { recursive: true })

  const lalphDirectory = await withCurrentDirectory(nestedDirectory, () =>
    run(resolveLalphDirectory),
  )

  assert.equal(lalphDirectory, directory)
})
