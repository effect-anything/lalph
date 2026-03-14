import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { Effect, Option, Schema } from "effect"
import { GitFlow, GitFlowError, GitFlowPR } from "./GitFlow.ts"
import { Hooks } from "./Hooks.ts"
import { IssueSource } from "./IssueSource.ts"
import { Prd } from "./Prd.ts"
import { CurrentProjectId } from "./Settings.ts"
import { PlatformServices } from "./shared/platform.ts"
import { type Worktree, makeExecHelpers } from "./Worktree.ts"
import { PrdIssue } from "./domain/PrdIssue.ts"
import { ProjectId } from "./domain/Project.ts"

const projectId = Schema.decodeUnknownSync(ProjectId)("AUT-71")

const makeGitDirectory = (branch: string) => {
  const directory = mkdtempSync(join(tmpdir(), "lalph-gitflow-"))
  execFileSync("git", ["init", "-b", branch], {
    cwd: directory,
    stdio: "pipe",
  })
  return directory
}

const makeJjDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), "lalph-gitflow-jj-"))
  const remoteDirectory = join(directory, "remote.git")
  const seedDirectory = join(directory, "seed")
  const repositoryDirectory = join(directory, "repo")

  execFileSync("git", ["init", "--bare", remoteDirectory], {
    stdio: "pipe",
  })
  execFileSync("git", ["clone", remoteDirectory, seedDirectory], {
    cwd: directory,
    stdio: "pipe",
  })
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: seedDirectory,
    stdio: "pipe",
  })
  execFileSync("git", ["config", "user.name", "Test User"], {
    cwd: seedDirectory,
    stdio: "pipe",
  })
  writeFileSync(join(seedDirectory, "README.md"), "init\n")
  execFileSync("git", ["add", "README.md"], {
    cwd: seedDirectory,
    stdio: "pipe",
  })
  execFileSync("git", ["commit", "-m", "init"], {
    cwd: seedDirectory,
    stdio: "pipe",
  })
  execFileSync("git", ["push", "origin", "HEAD:master"], {
    cwd: seedDirectory,
    stdio: "pipe",
  })
  execFileSync("jj", ["git", "clone", remoteDirectory, repositoryDirectory], {
    cwd: directory,
    stdio: "pipe",
  })

  return {
    directory,
    repositoryDirectory,
  }
}

const writeExecutable = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  chmodSync(path, 0o755)
}

const runAutoMerge = async (options: {
  readonly directory: string
  readonly issue: PrdIssue
  readonly worktree: Worktree["Service"]
  readonly updates: Array<Parameters<IssueSource["Service"]["updateIssue"]>[0]>
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const gitFlow = yield* GitFlow
      yield* gitFlow.autoMerge({
        issueId: options.issue.id!,
        targetBranch: undefined,
        worktree: options.worktree,
      })
    }).pipe(
      Effect.provide(GitFlowPR),
      Effect.provideService(CurrentProjectId, CurrentProjectId.of(projectId)),
      Effect.provideService(
        IssueSource,
        IssueSource.of({
          cancelIssue: () => Effect.void,
          cliAgentPresetInfo: () => Effect.void,
          createIssue: () => Effect.die("unused"),
          ensureInProgress: () => Effect.void,
          info: () => Effect.void,
          issueCliAgentPreset: () => Effect.succeed(Option.none()),
          issues: () => Effect.succeed([]),
          reset: Effect.void,
          settings: () => Effect.void,
          updateCliAgentPreset: () => Effect.die("unused"),
          updateIssue: (update) =>
            Effect.sync(() => {
              options.updates.push(update)
            }),
        }),
      ),
      Effect.provideService(
        Prd,
        Prd.of({
          findById: () => Effect.succeed(options.issue),
          flagUnmergable: () => Effect.void,
          maybeRevertIssue: () => Effect.void,
          path: join(options.directory, ".lalph", "prd.yml"),
          revertUpdatedIssues: Effect.void,
          setAutoMerge: () => Effect.void,
          setChosenIssueId: () => Effect.void,
        }),
      ),
      Effect.provide(PlatformServices),
    ),
  )

test("GitFlowPR.autoMerge runs pre-merge hooks before gh pr merge", async (t) => {
  const directory = makeGitDirectory("feature-pre-merge")
  t.after(() => {
    rmSync(directory, { force: true, recursive: true })
  })

  mkdirSync(join(directory, ".lalph"), { recursive: true })
  writeFileSync(
    join(directory, ".lalph", "hooks.yml"),
    `hooks:
  pre-merge:
    validate: >-
      printf '%s:%s\\n' '{{ workspace }}' "$LALPH_WORKTREE_PATH" >> .hook-log
`,
  )

  const helpers = await Effect.runPromise(
    makeExecHelpers({
      directory,
      githubRepo: undefined,
      mode: "in-place",
      projectId: "AUT-71",
      repository: {
        kind: "git",
        root: directory,
      },
      targetBranch: undefined,
    }).pipe(Effect.provide(Hooks.layer), Effect.provide(PlatformServices)),
  )

  const commands: Array<string> = []
  const updates: Array<Parameters<IssueSource["Service"]["updateIssue"]>[0]> =
    []
  const issue = new PrdIssue({
    autoMerge: true,
    blockedBy: [],
    description: "pre-merge test",
    estimate: null,
    id: "AUT-71",
    priority: 2,
    state: "in-review",
    title: "Integrate pre-merge hooks into GitFlow",
  })

  const worktree = {
    directory,
    exec: (
      template: TemplateStringsArray,
      ...args: Array<string | number | boolean>
    ) =>
      Effect.sync(() => {
        const command = String.raw({ raw: template }, ...args)
        commands.push(command)
        if (command === "gh pr merge -sd") {
          assert.equal(existsSync(join(directory, ".hook-log")), true)
          assert.equal(
            readFileSync(join(directory, ".hook-log"), "utf8"),
            `feature-pre-merge:${directory}\n`,
          )
        }
        return 0
      }),
    execShell: helpers.execShell,
    getHookTemplateValues: helpers.getHookTemplateValues,
    repository: {
      kind: "git" as const,
      root: directory,
    },
    viewPrState: (prNumber?: number) =>
      Effect.succeed(
        Option.some({
          number: prNumber ?? 17,
          state: prNumber ? "MERGED" : "OPEN",
        }),
      ),
  } as unknown as Worktree["Service"]

  await runAutoMerge({
    directory,
    issue,
    updates,
    worktree,
  })

  assert.deepEqual(commands, ["gh pr merge -sd"])
  assert.deepEqual(updates, [
    {
      issueId: "AUT-71",
      projectId,
      state: "done",
    },
  ])
})

test("GitFlowPR.autoMerge runs jj pre-merge hooks from the main workspace config", async (t) => {
  const { directory, repositoryDirectory } = makeJjDirectory()
  const workspaceDirectory = join(directory, "workspace")
  t.after(() => {
    rmSync(directory, { force: true, recursive: true })
  })

  execFileSync(
    "jj",
    ["workspace", "add", workspaceDirectory, "--name", "lalph-pre-merge"],
    {
      cwd: repositoryDirectory,
      stdio: "pipe",
    },
  )

  mkdirSync(join(repositoryDirectory, ".lalph"), { recursive: true })
  writeFileSync(
    join(repositoryDirectory, ".lalph", "hooks.yml"),
    `hooks:
  pre-merge:
    validate: >-
      printf '%s:%s\\n' '{{ workspace }}' "$LALPH_WORKTREE_PATH" >> .hook-log
`,
  )

  const helpers = await Effect.runPromise(
    makeExecHelpers({
      directory: workspaceDirectory,
      githubRepo: undefined,
      mode: "worktree",
      projectId: "AUT-77",
      repository: {
        kind: "jj",
        root: repositoryDirectory,
      },
      targetBranch: undefined,
    }).pipe(Effect.provide(Hooks.layer), Effect.provide(PlatformServices)),
  )

  const commands: Array<string> = []
  const updates: Array<Parameters<IssueSource["Service"]["updateIssue"]>[0]> =
    []
  const issue = new PrdIssue({
    autoMerge: true,
    blockedBy: [],
    description: "jj pre-merge test",
    estimate: null,
    id: "AUT-77",
    priority: 2,
    state: "in-review",
    title: "Add jj worktree coverage",
  })

  const worktree = {
    directory: workspaceDirectory,
    exec: (
      template: TemplateStringsArray,
      ...args: Array<string | number | boolean>
    ) =>
      Effect.sync(() => {
        const command = String.raw({ raw: template }, ...args)
        commands.push(command)
        if (command === "gh pr merge -sd") {
          assert.equal(existsSync(join(workspaceDirectory, ".hook-log")), true)
          assert.equal(
            readFileSync(join(workspaceDirectory, ".hook-log"), "utf8"),
            `lalph-pre-merge:${workspaceDirectory}\n`,
          )
        }
        return 0
      }),
    execShell: helpers.execShell,
    getHookTemplateValues: helpers.getHookTemplateValues,
    repository: {
      kind: "jj" as const,
      root: repositoryDirectory,
    },
    viewPrState: (prNumber?: number) =>
      Effect.succeed(
        Option.some({
          number: prNumber ?? 17,
          state: prNumber ? "MERGED" : "OPEN",
        }),
      ),
  } as unknown as Worktree["Service"]

  await runAutoMerge({
    directory: workspaceDirectory,
    issue,
    updates,
    worktree,
  })

  assert.deepEqual(commands, ["gh pr merge -sd"])
  assert.deepEqual(updates, [
    {
      issueId: "AUT-77",
      projectId,
      state: "done",
    },
  ])
})

test("GitFlowPR.autoMerge aborts merge when a pre-merge hook fails", async (t) => {
  const directory = makeGitDirectory("feature-pre-merge-fail")
  t.after(() => {
    rmSync(directory, { force: true, recursive: true })
  })

  mkdirSync(join(directory, ".lalph"), { recursive: true })
  writeFileSync(
    join(directory, ".lalph", "hooks.yml"),
    `hooks:
  pre-merge:
    validate: "echo broken >&2; exit 9"
`,
  )
  writeExecutable(
    join(directory, "bin", "gh"),
    `#!/usr/bin/env bash
set -euo pipefail
echo "gh should not run" >&2
exit 1
`,
  )

  const helpers = await Effect.runPromise(
    makeExecHelpers({
      directory,
      githubRepo: undefined,
      mode: "in-place",
      projectId: "AUT-71",
      repository: {
        kind: "git",
        root: directory,
      },
      targetBranch: undefined,
    }).pipe(Effect.provide(Hooks.layer), Effect.provide(PlatformServices)),
  )

  const commands: Array<string> = []
  const updates: Array<Parameters<IssueSource["Service"]["updateIssue"]>[0]> =
    []
  const issue = new PrdIssue({
    autoMerge: true,
    blockedBy: [],
    description: "pre-merge failure test",
    estimate: null,
    id: "AUT-71",
    priority: 2,
    state: "in-review",
    title: "Integrate pre-merge hooks into GitFlow",
  })

  const worktree = {
    directory,
    exec: (
      template: TemplateStringsArray,
      ...args: Array<string | number | boolean>
    ) =>
      Effect.sync(() => {
        commands.push(String.raw({ raw: template }, ...args))
        return 0
      }),
    execShell: helpers.execShell,
    getHookTemplateValues: helpers.getHookTemplateValues,
    repository: {
      kind: "git" as const,
      root: directory,
    },
    viewPrState: () =>
      Effect.succeed(
        Option.some({
          number: 17,
          state: "OPEN",
        }),
      ),
  } as unknown as Worktree["Service"]

  await assert.rejects(
    runAutoMerge({
      directory,
      issue,
      updates,
      worktree,
    }),
    (error: unknown) =>
      error instanceof GitFlowError &&
      error.message === 'Hook "pre-merge.validate" failed with exit code 9',
  )

  assert.deepEqual(commands, [])
  assert.deepEqual(updates, [])
})
