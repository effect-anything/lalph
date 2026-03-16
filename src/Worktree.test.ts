import assert from "node:assert/strict"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { execFileSync } from "node:child_process"
import test from "node:test"
import { Effect, Option, PlatformError, Schema } from "effect"
import { HookCommandFailedError, Hooks } from "./Hooks.ts"
import { Project, ProjectId } from "./domain/Project.ts"
import { PlatformServices } from "./shared/platform.ts"
import { makeJjWorkspaceName } from "./shared/vcs.ts"
import { CurrentProjectId, Settings } from "./Settings.ts"
import { Worktree, makeExecHelpers, setupWorktree } from "./Worktree.ts"

const makeGitDirectory = (branch: string) => {
  const directory = mkdtempSync(join(tmpdir(), "lalph-worktree-"))
  execFileSync("git", ["init", "-b", branch], {
    cwd: directory,
    stdio: "pipe",
  })
  return directory
}

const writeExecutable = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  chmodSync(path, 0o755)
}

const seedGitCommit = (directory: string) => {
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: directory,
    stdio: "pipe",
  })
  execFileSync("git", ["config", "user.name", "Test User"], {
    cwd: directory,
    stdio: "pipe",
  })
  execFileSync("git", ["config", "commit.gpgsign", "false"], {
    cwd: directory,
    stdio: "pipe",
  })
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], {
    cwd: directory,
    stdio: "pipe",
  })
}

const makeJjDirectory = (branches: ReadonlyArray<string> = []) => {
  const directory = mkdtempSync(join(tmpdir(), "lalph-jj-"))
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
  execFileSync("git", ["config", "commit.gpgsign", "false"], {
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
  const defaultBranch = execFileSync("git", ["branch", "--show-current"], {
    cwd: seedDirectory,
    encoding: "utf8",
    stdio: "pipe",
  }).trim()

  for (const branch of branches) {
    execFileSync("git", ["checkout", "-b", branch, defaultBranch], {
      cwd: seedDirectory,
      stdio: "pipe",
    })
    writeFileSync(
      join(seedDirectory, `${branch.replaceAll("/", "-")}.txt`),
      `${branch}\n`,
    )
    execFileSync("git", ["add", "."], {
      cwd: seedDirectory,
      stdio: "pipe",
    })
    execFileSync("git", ["commit", "-m", branch], {
      cwd: seedDirectory,
      stdio: "pipe",
    })
    execFileSync("git", ["push", "origin", `HEAD:${branch}`], {
      cwd: seedDirectory,
      stdio: "pipe",
    })
    execFileSync("git", ["checkout", defaultBranch], {
      cwd: seedDirectory,
      stdio: "pipe",
    })
  }

  execFileSync("jj", ["git", "clone", remoteDirectory, repositoryDirectory], {
    cwd: directory,
    stdio: "pipe",
  })

  return {
    directory,
    remoteDirectory,
    repositoryDirectory,
    seedDirectory,
  }
}

const settingsWithProjects = (...projects: ReadonlyArray<Project>) =>
  Settings.of({
    get: (setting) =>
      Effect.succeed(
        setting.name === "projects" ? Option.some(projects) : Option.none(),
      ),
    getProject: () => Effect.succeed(Option.none()),
    set: () => Effect.void,
    setProject: () => Effect.void,
  } as Settings["Service"])

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

const settingsWithoutProjects = Settings.of({
  get: () => Effect.succeed(Option.none()),
  getProject: () => Effect.succeed(Option.none()),
  set: () => Effect.void,
  setProject: () => Effect.void,
} as Settings["Service"])

const projectId = Schema.decodeUnknownSync(ProjectId)("AUT-70")

test("makeExecHelpers.execString injects hook environment variables", async (t) => {
  const directory = makeGitDirectory("feature-env")
  t.after(() => {
    rmSync(directory, { force: true, recursive: true })
  })

  const output = await Effect.runPromise(
    makeExecHelpers({
      directory,
      githubRepo: "tim-smart/lalph",
      mode: "in-place",
      projectId: "AUT-69",
      repository: {
        kind: "git",
        root: directory,
      },
      targetBranch: "origin/master",
    }).pipe(
      Effect.flatMap(
        ({ execString }) =>
          execString`node -e ${`
          process.stdout.write(
            JSON.stringify({
              GH_REPO: process.env.GH_REPO,
              LALPH_MAIN_WORKTREE_PATH: process.env.LALPH_MAIN_WORKTREE_PATH,
              LALPH_PROJECT_ID: process.env.LALPH_PROJECT_ID,
              LALPH_REPOSITORY_KIND: process.env.LALPH_REPOSITORY_KIND,
              LALPH_TARGET_BRANCH: process.env.LALPH_TARGET_BRANCH,
              LALPH_WORKSPACE_NAME: process.env.LALPH_WORKSPACE_NAME,
              LALPH_WORKTREE_MODE: process.env.LALPH_WORKTREE_MODE,
              LALPH_WORKTREE_PATH: process.env.LALPH_WORKTREE_PATH,
            }),
          )
        `}`,
      ),
      Effect.provide(Hooks.layer),
      Effect.provide(PlatformServices),
    ),
  )

  assert.deepEqual(JSON.parse(output), {
    GH_REPO: "tim-smart/lalph",
    LALPH_MAIN_WORKTREE_PATH: directory,
    LALPH_PROJECT_ID: "AUT-69",
    LALPH_REPOSITORY_KIND: "git",
    LALPH_TARGET_BRANCH: "origin/master",
    LALPH_WORKSPACE_NAME: "feature-env",
    LALPH_WORKTREE_MODE: "in-place",
    LALPH_WORKTREE_PATH: directory,
  })
})

test("makeExecHelpers.exec injects hook variables when optional values are unset", async (t) => {
  const directory = makeGitDirectory("feature-no-target")
  t.after(() => {
    rmSync(directory, { force: true, recursive: true })
  })

  const exitCode = await Effect.runPromise(
    makeExecHelpers({
      directory,
      githubRepo: undefined,
      mode: "worktree",
      projectId: "AUT-69",
      repository: {
        kind: "git",
        root: directory,
      },
      targetBranch: undefined,
    }).pipe(
      Effect.flatMap(
        ({ exec }) =>
          exec`node -e ${`
          const actual = {
            LALPH_MAIN_WORKTREE_PATH: process.env.LALPH_MAIN_WORKTREE_PATH,
            LALPH_PROJECT_ID: process.env.LALPH_PROJECT_ID,
            LALPH_REPOSITORY_KIND: process.env.LALPH_REPOSITORY_KIND,
            LALPH_TARGET_BRANCH: process.env.LALPH_TARGET_BRANCH,
            LALPH_WORKSPACE_NAME: process.env.LALPH_WORKSPACE_NAME,
            LALPH_WORKTREE_MODE: process.env.LALPH_WORKTREE_MODE,
            LALPH_WORKTREE_PATH: process.env.LALPH_WORKTREE_PATH,
          }
          const expected = ${JSON.stringify({
            LALPH_MAIN_WORKTREE_PATH: directory,
            LALPH_PROJECT_ID: "AUT-69",
            LALPH_REPOSITORY_KIND: "git",
            LALPH_TARGET_BRANCH: "",
            LALPH_WORKSPACE_NAME: "feature-no-target",
            LALPH_WORKTREE_MODE: "worktree",
            LALPH_WORKTREE_PATH: directory,
          })}
          if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            console.error(JSON.stringify({ actual, expected }))
            process.exit(1)
          }
        `}`,
      ),
      Effect.provide(Hooks.layer),
      Effect.provide(PlatformServices),
    ),
  )

  assert.equal(exitCode, 0)
})

test("setupWorktree executes post-create hooks in sorted order and ignores worktree-setup.sh", async (t) => {
  const directory = makeGitDirectory("feature-hooks")
  t.after(() => {
    rmSync(directory, { force: true, recursive: true })
  })

  mkdirSync(join(directory, ".lalph"), { recursive: true })
  writeFileSync(
    join(directory, ".lalph", "hooks.yml"),
    `hooks:
  post-create:
    z-last: >-
      printf 'z:%s\\n' '{{ main_worktree_path }}' >> .hook-log
    a-first: >-
      printf 'a:%s:%s\\n' '{{ workspace }}' "$LALPH_MAIN_WORKTREE_PATH" >> .hook-log
`,
  )
  writeExecutable(
    join(directory, "scripts", "worktree-setup.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'legacy\\n' >> .legacy-log
`,
  )

  await Effect.runPromise(
    makeExecHelpers({
      directory,
      githubRepo: undefined,
      mode: "worktree",
      projectId: "AUT-70",
      repository: {
        kind: "git",
        root: directory,
      },
      targetBranch: undefined,
    }).pipe(
      Effect.flatMap(({ exec, execShell, getHookTemplateValues }) =>
        setupWorktree({
          directory,
          exec,
          execShell,
          getHookTemplateValues,
          repository: {
            kind: "git",
            root: directory,
          },
        }),
      ),
      Effect.provide(Hooks.layer),
      Effect.provideService(CurrentProjectId, CurrentProjectId.of(projectId)),
      Effect.provideService(Settings, settingsWithoutProjects),
      Effect.provide(PlatformServices),
    ),
  )

  assert.equal(
    readFileSync(join(directory, ".hook-log"), "utf8"),
    `a:feature-hooks:${directory}\nz:${directory}\n`,
  )
  assert.equal(existsSync(join(directory, ".legacy-log")), false)
})

test("setupWorktree falls back to worktree-setup.sh when hooks.yml is missing", async (t) => {
  const directory = makeGitDirectory("feature-legacy")
  t.after(() => {
    rmSync(directory, { force: true, recursive: true })
  })

  writeExecutable(
    join(directory, "scripts", "worktree-setup.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s:%s\\n' "$LALPH_WORKSPACE_NAME" "$LALPH_MAIN_WORKTREE_PATH" >> .legacy-log
`,
  )

  await Effect.runPromise(
    makeExecHelpers({
      directory,
      githubRepo: undefined,
      mode: "worktree",
      projectId: "AUT-70",
      repository: {
        kind: "git",
        root: directory,
      },
      targetBranch: undefined,
    }).pipe(
      Effect.flatMap(({ exec, execShell, getHookTemplateValues }) =>
        setupWorktree({
          directory,
          exec,
          execShell,
          getHookTemplateValues,
          repository: {
            kind: "git",
            root: directory,
          },
        }),
      ),
      Effect.provide(Hooks.layer),
      Effect.provideService(CurrentProjectId, CurrentProjectId.of(projectId)),
      Effect.provideService(Settings, settingsWithoutProjects),
      Effect.provide(PlatformServices),
    ),
  )

  assert.equal(
    readFileSync(join(directory, ".legacy-log"), "utf8"),
    `feature-legacy:${directory}\n`,
  )
})

test("setupWorktree fails when a post-create hook exits non-zero", async (t) => {
  const directory = makeGitDirectory("feature-hook-failure")
  t.after(() => {
    rmSync(directory, { force: true, recursive: true })
  })

  mkdirSync(join(directory, ".lalph"), { recursive: true })
  writeFileSync(
    join(directory, ".lalph", "hooks.yml"),
    `hooks:
  post-create:
    fail: "echo broken >&2; exit 7"
`,
  )
  writeExecutable(
    join(directory, "scripts", "worktree-setup.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'legacy\\n' >> .legacy-log
`,
  )

  await assert.rejects(
    Effect.runPromise(
      makeExecHelpers({
        directory,
        githubRepo: undefined,
        mode: "worktree",
        projectId: "AUT-70",
        repository: {
          kind: "git",
          root: directory,
        },
        targetBranch: undefined,
      }).pipe(
        Effect.flatMap(({ exec, execShell, getHookTemplateValues }) =>
          setupWorktree({
            directory,
            exec,
            execShell,
            getHookTemplateValues,
            repository: {
              kind: "git",
              root: directory,
            },
          }),
        ),
        Effect.provide(Hooks.layer),
        Effect.provideService(CurrentProjectId, CurrentProjectId.of(projectId)),
        Effect.provideService(Settings, settingsWithoutProjects),
        Effect.provide(PlatformServices),
      ),
    ),
    (error: unknown) =>
      error instanceof HookCommandFailedError &&
      error.hookName === "fail" &&
      error.exitCode === 7,
  )

  assert.equal(existsSync(join(directory, ".legacy-log")), false)
})

test(
  "Worktree.layer creates jj workspaces, runs post-create hooks, and cleans them up",
  { concurrency: false },
  async (t) => {
    const { directory, repositoryDirectory } = makeJjDirectory(["release"])
    t.after(() => {
      rmSync(directory, { force: true, recursive: true })
    })

    mkdirSync(join(repositoryDirectory, ".lalph"), { recursive: true })
    writeFileSync(
      join(repositoryDirectory, ".lalph", "hooks.yml"),
      `hooks:
  post-create:
    capture: >-
      printf '%s:%s:%s\\n' '{{ workspace }}' "$LALPH_TARGET_BRANCH" "$LALPH_MAIN_WORKTREE_PATH" >> .hook-log
`,
    )

    const jjProjectId = Schema.decodeUnknownSync(ProjectId)("AUT-77")
    const project = new Project({
      checkoutMode: "worktree",
      concurrency: 1,
      enabled: true,
      gitFlow: "commit",
      id: jjProjectId,
      reviewAgent: false,
      reviewCompletion: "manual",
      targetBranch: Option.some("origin/release"),
    })

    const result = await withCurrentDirectory(repositoryDirectory, () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const worktree = yield* Worktree
            const templateValues = yield* worktree.getHookTemplateValues
            const workspaceList = execFileSync(
              "jj",
              ["workspace", "list", "--color", "never"],
              {
                cwd: repositoryDirectory,
                encoding: "utf8",
                stdio: "pipe",
              },
            )
            const parentDescription = execFileSync(
              "jj",
              ["log", "-r", "@-", "--no-graph", "-T", 'description ++ "\\n"'],
              {
                cwd: worktree.directory,
                encoding: "utf8",
                stdio: "pipe",
              },
            )
            return {
              hookLog: readFileSync(
                join(worktree.directory, ".hook-log"),
                "utf8",
              ),
              parentDescription,
              workspaceList,
              workspaceName: templateValues.workspace,
              worktreeDirectory: worktree.directory,
            } as const
          }).pipe(
            Effect.provide(Worktree.layer),
            Effect.provideService(
              CurrentProjectId,
              CurrentProjectId.of(jjProjectId),
            ),
            Effect.provideService(Settings, settingsWithProjects(project)),
            Effect.provide(PlatformServices),
          ),
        ),
      ),
    )

    assert.equal(
      result.workspaceName,
      makeJjWorkspaceName(basename(result.worktreeDirectory)),
    )
    assert.equal(
      result.hookLog,
      `${result.workspaceName}:origin/release:${realpathSync(repositoryDirectory)}\n`,
    )
    assert.equal(result.parentDescription.trimEnd(), "release")
    assert.equal(
      result.workspaceList.includes(`${result.workspaceName}:`),
      true,
    )
    assert.equal(result.worktreeDirectory === repositoryDirectory, false)
    assert.equal(existsSync(result.worktreeDirectory), false)

    const workspaceListAfter = execFileSync(
      "jj",
      ["workspace", "list", "--color", "never"],
      {
        cwd: repositoryDirectory,
        encoding: "utf8",
        stdio: "pipe",
      },
    )

    assert.equal(workspaceListAfter.includes(`${result.workspaceName}:`), false)
  },
)

test(
  "Worktree.layer creates jj workspaces from a local target bookmark without fetching a remote",
  { concurrency: false },
  async (t) => {
    const { directory, repositoryDirectory } = makeJjDirectory(["release"])
    t.after(() => {
      rmSync(directory, { force: true, recursive: true })
    })

    execFileSync(
      "jj",
      ["bookmark", "set", "release", "--revision", "release@origin"],
      {
        cwd: repositoryDirectory,
        stdio: "pipe",
      },
    )

    mkdirSync(join(repositoryDirectory, ".lalph"), { recursive: true })
    writeFileSync(
      join(repositoryDirectory, ".lalph", "hooks.yml"),
      `hooks:
  post-create:
    capture: >-
      printf '%s:%s\\n' '{{ workspace }}' "$LALPH_TARGET_BRANCH" >> .hook-log
`,
    )

    const jjProjectId = Schema.decodeUnknownSync(ProjectId)("AUT-79")
    const project = new Project({
      checkoutMode: "worktree",
      concurrency: 1,
      enabled: true,
      gitFlow: "commit",
      id: jjProjectId,
      reviewAgent: false,
      reviewCompletion: "manual",
      targetBranch: Option.some("release"),
    })

    const result = await withCurrentDirectory(repositoryDirectory, () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const worktree = yield* Worktree
            const parentDescription = execFileSync(
              "jj",
              ["log", "-r", "@-", "--no-graph", "-T", 'description ++ "\\n"'],
              {
                cwd: worktree.directory,
                encoding: "utf8",
                stdio: "pipe",
              },
            )
            return {
              hookLog: readFileSync(
                join(worktree.directory, ".hook-log"),
                "utf8",
              ),
              parentDescription,
            } as const
          }).pipe(
            Effect.provide(Worktree.layer),
            Effect.provideService(
              CurrentProjectId,
              CurrentProjectId.of(jjProjectId),
            ),
            Effect.provideService(Settings, settingsWithProjects(project)),
            Effect.provide(PlatformServices),
          ),
        ),
      ),
    )

    assert.equal(result.hookLog.endsWith(":release\n"), true)
    assert.equal(result.parentDescription.trimEnd(), "release")
  },
)

test(
  "Worktree.layerWorktree creates jj workspaces even when the project uses in-place mode",
  { concurrency: false },
  async (t) => {
    const { directory, repositoryDirectory } = makeJjDirectory()
    t.after(() => {
      rmSync(directory, { force: true, recursive: true })
    })

    mkdirSync(join(repositoryDirectory, ".lalph"), { recursive: true })

    const jjProjectId = Schema.decodeUnknownSync(ProjectId)("AUT-78")
    const project = new Project({
      checkoutMode: "in-place",
      concurrency: 1,
      enabled: true,
      gitFlow: "commit",
      id: jjProjectId,
      reviewAgent: false,
      reviewCompletion: "manual",
      targetBranch: Option.none(),
    })

    const result = await withCurrentDirectory(repositoryDirectory, () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const worktree = yield* Worktree
            const workspaceList = execFileSync(
              "jj",
              ["workspace", "list", "--color", "never"],
              {
                cwd: repositoryDirectory,
                encoding: "utf8",
                stdio: "pipe",
              },
            )
            return {
              mode: worktree.mode,
              workspaceList,
              worktreeDirectory: worktree.directory,
            } as const
          }).pipe(
            Effect.provide(Worktree.layerWorktree),
            Effect.provideService(
              CurrentProjectId,
              CurrentProjectId.of(jjProjectId),
            ),
            Effect.provideService(Settings, settingsWithProjects(project)),
            Effect.provide(PlatformServices),
          ),
        ),
      ),
    )

    assert.equal(result.mode, "worktree")
    assert.equal(result.worktreeDirectory === repositoryDirectory, false)
    assert.equal(
      result.workspaceList.includes(
        `${makeJjWorkspaceName(basename(result.worktreeDirectory))}:`,
      ),
      true,
    )
    assert.equal(existsSync(result.worktreeDirectory), false)
  },
)

test("checkoutPr executes post-switch hooks after successful PR checkout", async (t) => {
  const directory = makeGitDirectory("feature-switch-source")
  const previousPath = process.env.PATH ?? ""
  t.after(() => {
    process.env.PATH = previousPath
    rmSync(directory, { force: true, recursive: true })
  })

  seedGitCommit(directory)
  execFileSync("git", ["branch", "pr-17"], {
    cwd: directory,
    stdio: "pipe",
  })

  mkdirSync(join(directory, ".lalph"), { recursive: true })
  writeFileSync(
    join(directory, ".lalph", "hooks.yml"),
    `hooks:
  post-switch:
    notify: >-
      printf '%s:%s\\n' '{{ workspace }}' "$LALPH_WORKTREE_PATH" >> .switch-log
`,
  )
  writeExecutable(
    join(directory, "bin", "gh"),
    `#!/usr/bin/env bash
set -euo pipefail

if [[ "$1" != "pr" || "$2" != "checkout" || "$3" != "17" ]]; then
  echo "unexpected gh arguments: $*" >&2
  exit 1
fi

git checkout pr-17 >/dev/null
`,
  )
  process.env.PATH = `${join(directory, "bin")}:${previousPath}`

  const exitCode = await Effect.runPromise(
    makeExecHelpers({
      directory,
      githubRepo: undefined,
      mode: "in-place",
      projectId: "AUT-72",
      repository: {
        kind: "git",
        root: directory,
      },
      targetBranch: undefined,
    }).pipe(
      Effect.flatMap(({ checkoutPr }) => checkoutPr(17)),
      Effect.provide(Hooks.layer),
      Effect.provide(PlatformServices),
    ),
  )

  assert.equal(exitCode, 0)
  assert.equal(
    execFileSync("git", ["branch", "--show-current"], {
      cwd: directory,
      encoding: "utf8",
      stdio: "pipe",
    }).trim(),
    "pr-17",
  )
  assert.equal(
    readFileSync(join(directory, ".switch-log"), "utf8"),
    `pr-17:${directory}\n`,
  )
})

test("runPostSwitchHooks executes hooks for an existing git worktree", async (t) => {
  const directory = makeGitDirectory("feature-switch-source")
  const worktreeDirectory = join(dirname(directory), "manual-switch-worktree")
  t.after(() => {
    rmSync(worktreeDirectory, { force: true, recursive: true })
    rmSync(directory, { force: true, recursive: true })
  })

  seedGitCommit(directory)
  execFileSync("git", ["branch", "feature/manual"], {
    cwd: directory,
    stdio: "pipe",
  })
  execFileSync(
    "git",
    ["worktree", "add", worktreeDirectory, "feature/manual"],
    {
      cwd: directory,
      stdio: "pipe",
    },
  )

  mkdirSync(join(directory, ".lalph"), { recursive: true })
  writeFileSync(
    join(directory, ".lalph", "hooks.yml"),
    `hooks:
  post-switch:
    notify: >-
      printf '%s:%s\\n' '{{ workspace }}' "$LALPH_WORKTREE_PATH" >> .switch-log
`,
  )

  await Effect.runPromise(
    makeExecHelpers({
      directory: worktreeDirectory,
      githubRepo: undefined,
      mode: "worktree",
      projectId: "AUT-79",
      repository: {
        kind: "git",
        root: directory,
      },
      targetBranch: undefined,
    }).pipe(
      Effect.flatMap(({ runPostSwitchHooks }) =>
        runPostSwitchHooks("switchWorkspace"),
      ),
      Effect.provide(Hooks.layer),
      Effect.provide(PlatformServices),
    ),
  )

  assert.equal(
    readFileSync(join(worktreeDirectory, ".switch-log"), "utf8"),
    `feature/manual:${worktreeDirectory}\n`,
  )
})

test("checkoutPr executes post-switch hooks after successful jj PR checkout", async (t) => {
  const { directory, repositoryDirectory } = makeJjDirectory(["pr-17"])
  const workspaceDirectory = join(directory, "workspace")
  const previousPath = process.env.PATH ?? ""
  t.after(() => {
    process.env.PATH = previousPath
    rmSync(directory, { force: true, recursive: true })
  })

  execFileSync(
    "jj",
    ["workspace", "add", workspaceDirectory, "--name", "lalph-switch"],
    {
      cwd: repositoryDirectory,
      stdio: "pipe",
    },
  )

  mkdirSync(join(repositoryDirectory, ".lalph"), { recursive: true })
  writeFileSync(
    join(repositoryDirectory, ".lalph", "hooks.yml"),
    `hooks:
  post-switch:
    notify: >-
      printf '%s:%s\\n' '{{ workspace }}' "$LALPH_WORKTREE_PATH" >> .switch-log
`,
  )
  writeExecutable(
    join(workspaceDirectory, "bin", "gh"),
    `#!/usr/bin/env bash
set -euo pipefail

if [[ "$1" != "pr" || "$2" != "view" || "$3" != "17" || "$4" != "--json" || "$5" != "headRefName" ]]; then
  echo "unexpected gh arguments: $*" >&2
  exit 1
fi

printf '{"headRefName":"pr-17"}'
`,
  )
  process.env.PATH = `${join(workspaceDirectory, "bin")}:${previousPath}`

  const exitCode = await Effect.runPromise(
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
    }).pipe(
      Effect.flatMap(({ checkoutPr }) => checkoutPr(17)),
      Effect.provide(Hooks.layer),
      Effect.provide(PlatformServices),
    ),
  )

  assert.equal(exitCode, 0)
  assert.equal(
    execFileSync(
      "jj",
      ["log", "-r", "@-", "--no-graph", "-T", 'description ++ "\\n"'],
      {
        cwd: workspaceDirectory,
        encoding: "utf8",
        stdio: "pipe",
      },
    ).trimEnd(),
    "pr-17",
  )
  assert.equal(
    readFileSync(join(workspaceDirectory, ".switch-log"), "utf8"),
    `lalph-switch:${workspaceDirectory}\n`,
  )
})

test("runPostSwitchHooks executes hooks for an existing jj workspace", async (t) => {
  const { directory, repositoryDirectory } = makeJjDirectory()
  const workspaceDirectory = join(directory, "manual-switch-workspace")
  t.after(() => {
    rmSync(directory, { force: true, recursive: true })
  })

  execFileSync(
    "jj",
    ["workspace", "add", workspaceDirectory, "--name", "lalph-manual"],
    {
      cwd: repositoryDirectory,
      stdio: "pipe",
    },
  )

  mkdirSync(join(repositoryDirectory, ".lalph"), { recursive: true })
  writeFileSync(
    join(repositoryDirectory, ".lalph", "hooks.yml"),
    `hooks:
  post-switch:
    notify: >-
      printf '%s:%s\\n' '{{ workspace }}' "$LALPH_WORKTREE_PATH" >> .switch-log
`,
  )

  await Effect.runPromise(
    makeExecHelpers({
      directory: workspaceDirectory,
      githubRepo: undefined,
      mode: "worktree",
      projectId: "AUT-79",
      repository: {
        kind: "jj",
        root: repositoryDirectory,
      },
      targetBranch: undefined,
    }).pipe(
      Effect.flatMap(({ runPostSwitchHooks }) =>
        runPostSwitchHooks("switchWorkspace"),
      ),
      Effect.provide(Hooks.layer),
      Effect.provide(PlatformServices),
    ),
  )

  assert.equal(
    readFileSync(join(workspaceDirectory, ".switch-log"), "utf8"),
    `lalph-manual:${workspaceDirectory}\n`,
  )
})

test("checkoutPr fails when a post-switch hook exits non-zero", async (t) => {
  const directory = makeGitDirectory("feature-switch-failure")
  const previousPath = process.env.PATH ?? ""
  t.after(() => {
    process.env.PATH = previousPath
    rmSync(directory, { force: true, recursive: true })
  })

  seedGitCommit(directory)
  execFileSync("git", ["branch", "pr-17"], {
    cwd: directory,
    stdio: "pipe",
  })

  mkdirSync(join(directory, ".lalph"), { recursive: true })
  writeFileSync(
    join(directory, ".lalph", "hooks.yml"),
    `hooks:
  post-switch:
    fail: "echo broken >&2; exit 6"
`,
  )
  writeExecutable(
    join(directory, "bin", "gh"),
    `#!/usr/bin/env bash
set -euo pipefail

if [[ "$1" != "pr" || "$2" != "checkout" || "$3" != "17" ]]; then
  echo "unexpected gh arguments: $*" >&2
  exit 1
fi

git checkout pr-17 >/dev/null
`,
  )
  process.env.PATH = `${join(directory, "bin")}:${previousPath}`

  await assert.rejects(
    Effect.runPromise(
      makeExecHelpers({
        directory,
        githubRepo: undefined,
        mode: "in-place",
        projectId: "AUT-72",
        repository: {
          kind: "git",
          root: directory,
        },
        targetBranch: undefined,
      }).pipe(
        Effect.flatMap(({ checkoutPr }) => checkoutPr(17)),
        Effect.provide(Hooks.layer),
        Effect.provide(PlatformServices),
      ),
    ),
    (error: unknown) =>
      error instanceof PlatformError.PlatformError &&
      error.message ===
        'Worktree.checkoutPr: Hook "post-switch.fail" failed with exit code 6',
  )

  assert.equal(
    execFileSync("git", ["branch", "--show-current"], {
      cwd: directory,
      encoding: "utf8",
      stdio: "pipe",
    }).trim(),
    "pr-17",
  )
})
