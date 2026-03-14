import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import test from "node:test"
import { Effect } from "effect"
import { PlatformServices } from "./platform.ts"
import {
  formatRepositoryWorkspace,
  listRepositoryWorkspaces,
  pruneRepositoryWorkspaces,
  RepositoryWorkspaceIsDefault,
  removeRepositoryWorkspace,
  type RepositoryInfo,
  type RepositoryWorkspace,
} from "./vcs.ts"

const makeGitRepository = () => {
  const directory = mkdtempSync(join(tmpdir(), "lalph-vcs-git-"))
  execFileSync("git", ["init", directory, "-b", "master"], {
    stdio: "pipe",
  })
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: directory,
    stdio: "pipe",
  })
  execFileSync("git", ["config", "user.name", "Test User"], {
    cwd: directory,
    stdio: "pipe",
  })
  writeFileSync(join(directory, "README.md"), "init\n")
  execFileSync("git", ["add", "README.md"], {
    cwd: directory,
    stdio: "pipe",
  })
  execFileSync("git", ["commit", "-m", "init"], {
    cwd: directory,
    stdio: "pipe",
  })
  return directory
}

const makeJjRepository = () => {
  const directory = mkdtempSync(join(tmpdir(), "lalph-vcs-jj-"))
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

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(
    Effect.provide(effect, PlatformServices) as Effect.Effect<A, E, never>,
  )

test("listRepositoryWorkspaces lists current and extra git worktrees", async (t) => {
  const directory = makeGitRepository()
  const worktreeDirectory = join(
    dirname(directory),
    `${basename(directory)}-feature-worktree`,
  )
  t.after(() => {
    rmSync(directory, { force: true, recursive: true })
    rmSync(worktreeDirectory, { force: true, recursive: true })
  })

  execFileSync("git", ["branch", "feature/test"], {
    cwd: directory,
    stdio: "pipe",
  })
  execFileSync("git", ["worktree", "add", worktreeDirectory, "feature/test"], {
    cwd: directory,
    stdio: "pipe",
  })

  const workspaces = await run(
    listRepositoryWorkspaces({
      kind: "git",
      root: directory,
    } satisfies RepositoryInfo),
  )

  assert.equal(workspaces.length, 2)
  assert.equal(
    workspaces.some((workspace) => workspace.current),
    true,
  )
  assert.equal(
    workspaces.some(
      (workspace) =>
        workspace.kind === "git" && workspace.branch === "feature/test",
    ),
    true,
  )
  assert.equal(
    workspaces
      .filter((workspace) => workspace.kind === "git")
      .map((workspace) => formatRepositoryWorkspace(workspace))
      .some((line) => line.startsWith("* default -> ")),
    true,
  )
})

test("formatRepositoryWorkspace labels current git worktree as default", () => {
  assert.equal(
    formatRepositoryWorkspace({
      kind: "git",
      path: "/repo",
      current: true,
      default: true,
      branch: "master",
      branchRef: "refs/heads/master",
    } satisfies RepositoryWorkspace),
    "* default -> /repo",
  )

  assert.equal(
    formatRepositoryWorkspace({
      kind: "git",
      path: "/repo",
      current: true,
      default: true,
      branch: "feat/worktree-management",
      branchRef: "refs/heads/feat/worktree-management",
    } satisfies RepositoryWorkspace),
    "* default (feat/worktree-management) -> /repo",
  )

  assert.equal(
    formatRepositoryWorkspace({
      kind: "git",
      path: "/repo/wt",
      current: false,
      default: false,
      branch: undefined,
      branchRef: undefined,
    } satisfies RepositoryWorkspace),
    "  detached -> /repo/wt",
  )
})

test("removeRepositoryWorkspace removes a git worktree by branch name", async (t) => {
  const directory = makeGitRepository()
  const worktreeDirectory = join(
    dirname(directory),
    `${basename(directory)}-remove-worktree`,
  )
  t.after(() => {
    rmSync(directory, { force: true, recursive: true })
    rmSync(worktreeDirectory, { force: true, recursive: true })
  })

  execFileSync("git", ["branch", "feature/remove"], {
    cwd: directory,
    stdio: "pipe",
  })
  execFileSync(
    "git",
    ["worktree", "add", worktreeDirectory, "feature/remove"],
    {
      cwd: directory,
      stdio: "pipe",
    },
  )

  const removed = await run(
    removeRepositoryWorkspace(
      {
        kind: "git",
        root: directory,
      } satisfies RepositoryInfo,
      "feature/remove",
    ),
  )

  assert.equal(removed.kind, "git")
  assert.equal(existsSync(worktreeDirectory), false)

  const workspaces = await run(
    listRepositoryWorkspaces({
      kind: "git",
      root: directory,
    } satisfies RepositoryInfo),
  )
  assert.equal(workspaces.length, 1)
})

test("removeRepositoryWorkspace does not remove the default git worktree", async (t) => {
  const directory = makeGitRepository()
  t.after(() => {
    rmSync(directory, { force: true, recursive: true })
  })

  await assert.rejects(
    run(
      removeRepositoryWorkspace(
        {
          kind: "git",
          root: directory,
        } satisfies RepositoryInfo,
        directory,
      ),
    ),
    (error: unknown) =>
      error instanceof RepositoryWorkspaceIsDefault &&
      error.workspace.kind === "git" &&
      error.workspace.default,
  )
})

test("pruneRepositoryWorkspaces removes stale git worktree registrations", async (t) => {
  const directory = makeGitRepository()
  const worktreeDirectory = join(
    dirname(directory),
    `${basename(directory)}-stale-worktree`,
  )
  t.after(() => {
    rmSync(directory, { force: true, recursive: true })
    rmSync(worktreeDirectory, { force: true, recursive: true })
  })

  execFileSync("git", ["branch", "feature/stale"], {
    cwd: directory,
    stdio: "pipe",
  })
  execFileSync("git", ["worktree", "add", worktreeDirectory, "feature/stale"], {
    cwd: directory,
    stdio: "pipe",
  })
  rmSync(worktreeDirectory, { force: true, recursive: true })

  const removed = await run(
    pruneRepositoryWorkspaces({
      kind: "git",
      root: directory,
    } satisfies RepositoryInfo),
  )

  assert.equal(removed.length, 1)
  assert.equal(removed[0]?.kind, "git")

  const workspaces = await run(
    listRepositoryWorkspaces({
      kind: "git",
      root: directory,
    } satisfies RepositoryInfo),
  )
  assert.equal(workspaces.length, 1)
})

test("removeRepositoryWorkspace and pruneRepositoryWorkspaces support jj workspaces", async (t) => {
  const { directory, repositoryDirectory } = makeJjRepository()
  const workspaceDirectory = join(directory, "feature-workspace")
  const staleWorkspaceDirectory = join(directory, "stale-workspace")
  t.after(() => {
    rmSync(directory, { force: true, recursive: true })
  })

  execFileSync(
    "jj",
    ["workspace", "add", workspaceDirectory, "--name", "lalph-feature"],
    {
      cwd: repositoryDirectory,
      stdio: "pipe",
    },
  )
  execFileSync(
    "jj",
    ["workspace", "add", staleWorkspaceDirectory, "--name", "lalph-stale"],
    {
      cwd: repositoryDirectory,
      stdio: "pipe",
    },
  )

  const initial = await run(
    listRepositoryWorkspaces({
      kind: "jj",
      root: repositoryDirectory,
    } satisfies RepositoryInfo),
  )
  assert.equal(
    initial.some(
      (workspace) =>
        workspace.kind === "jj" && workspace.workspaceName === "lalph-feature",
    ),
    true,
  )
  assert.equal(
    initial.some(
      (workspace) =>
        workspace.kind === "jj" &&
        workspace.workspaceName === "default" &&
        workspace.default,
    ),
    true,
  )

  const removed = await run(
    removeRepositoryWorkspace(
      {
        kind: "jj",
        root: repositoryDirectory,
      } satisfies RepositoryInfo,
      "lalph-feature",
    ),
  )
  assert.equal(removed.kind, "jj")
  assert.equal(existsSync(workspaceDirectory), false)

  rmSync(staleWorkspaceDirectory, { force: true, recursive: true })

  const pruned = await run(
    pruneRepositoryWorkspaces({
      kind: "jj",
      root: repositoryDirectory,
    } satisfies RepositoryInfo),
  )
  assert.equal(pruned.length, 1)
  assert.equal(pruned[0]?.kind, "jj")

  const final = await run(
    listRepositoryWorkspaces({
      kind: "jj",
      root: repositoryDirectory,
    } satisfies RepositoryInfo),
  )
  assert.equal(
    final.every((workspace) => workspace.current),
    true,
  )
  assert.equal(final.length, 1)
})

test("removeRepositoryWorkspace does not remove the default jj workspace", async (t) => {
  const { directory, repositoryDirectory } = makeJjRepository()
  t.after(() => {
    rmSync(directory, { force: true, recursive: true })
  })

  await assert.rejects(
    run(
      removeRepositoryWorkspace(
        {
          kind: "jj",
          root: repositoryDirectory,
        } satisfies RepositoryInfo,
        "default",
      ),
    ),
    (error: unknown) =>
      error instanceof RepositoryWorkspaceIsDefault &&
      error.workspace.kind === "jj" &&
      error.workspace.workspaceName === "default",
  )
})
