```
  .--.
 |^()^|  lalph
  '--'
```

A LLM agent orchestrator driven by your chosen source of issues.

## Features

- Pull work from an issue source (GitHub Issues, Linear, etc.) and keep task state in sync
- Projects to group execution settings (enabled state, concurrency, target branch, git flow, review agent)
- Agent presets to control which CLI agent and optional clanka model run tasks, with optional label-based routing
- Plan mode to turn a high-level plan into a spec and generate PRD tasks
- Git worktrees to support multiple concurrent iterations
- Configurable lifecycle hooks for worktree setup, switching, and pre-merge validation
- Optional PR flow with auto-merge and support for issue dependencies

## Installation

```bash
npm install -g lalph
```

or run with npx:

```bash
npx -y lalph@latest
```

## CLI usage

- Run the main loop across enabled projects: `lalph`
- Run a bounded set of iterations per enabled project: `lalph --iterations 1`
- Configure projects and per-project concurrency: `lalph projects add`
- Inspect or dry-run configured lifecycle hooks: `lalph hooks list`
- List, switch, or remove temporary worktrees and jj workspaces: `lalph worktree list`
- Inspect and configure agent presets: `lalph agents ls`
- Start plan mode: `lalph plan`
- Create an issue from your editor: `lalph issue`
- Choose your issue source integration (applies to all projects): `lalph source`

It is recommended to add `.lalph/` to your `.gitignore` to avoid committing your
credentials.

## Agent presets

Agent presets define which CLI agent runs tasks, the optional clanka model to
use, and any extra arguments. Lalph always needs a default preset and will
prompt you to create one on first run if it's missing.

Some issue sources support routing: you can associate a preset with a label, and
issues with that label will run with that preset; anything else uses the default.

```bash
lalph agents ls
lalph agents add
```

`lalph agents ls` shows each preset's CLI agent, clanka model selection,
extra args, command prefix, and any issue-source routing metadata.

## Projects

Projects bundle execution settings for the current repo: whether it is enabled
for runs, how many tasks can run concurrently, which branch to target, what git
flow to use, and whether review is enabled.

`lalph` runs across all enabled projects in parallel; for single-project
commands, you'll be prompted to choose an active project when needed.

```bash
lalph projects add
lalph projects toggle
```

## Worktree Management

Use `lalph worktree` to inspect and clean up temporary git worktrees or jj
workspaces outside the main task loop. This is useful when a previous run was
interrupted and left extra checkouts behind.

```bash
lalph worktree list
lalph worktree switch
lalph worktree switch feature/my-branch
lalph worktree rm
lalph worktree rm feature/my-branch
lalph worktree prune
```

`rm` accepts a branch name, workspace name, path, or path basename. If you omit
it, lalph prompts you to choose a removable entry. `switch` opens a shell in an
existing worktree or workspace after running `post-switch` hooks. `prune`
removes stale entries whose directories are already gone.

## Hooks

Project-level hooks live in `.lalph/hooks.yml`. They let you run shell commands
after a worktree is created, before a PR is merged, and after switching to an
existing PR.

Hook sections:

- `post-create`: prepare a new worktree or jj workspace
- `pre-merge`: run validation before `gh pr merge`
- `post-switch`: refresh state after `lalph` checks out an existing PR

Use these commands to inspect hook config and dry-run interpolated commands:

```bash
lalph hooks list
lalph hooks test pre-merge
```

Example `.lalph/hooks.yml`:

```yaml
hooks:
  post-create:
    install: "pnpm install --frozen-lockfile"
  pre-merge:
    validate: "pnpm check"
  post-switch:
    notify: "echo Switched to {{ workspace }}"
```

Optimized example that reuses files from the main worktree:

```yaml
hooks:
  post-create:
    deps: "cp --reflink=auto -r {{ main_worktree_path }}/node_modules . || pnpm install --frozen-lockfile"
    env: "cp {{ main_worktree_path }}/.env.keys ."
    repos: "cp --reflink=auto -r {{ main_worktree_path }}/.repos ."
  pre-merge:
    validate: "pnpm check"
```

Available template variables:

- `{{ main_worktree_path }}`
- `{{ worktree_path }}`
- `{{ workspace }}`
- `{{ project_id }}`
- `{{ target_branch }}`
- `{{ repository_kind }}`

Hook commands also receive matching `LALPH_*` environment variables, including
`LALPH_MAIN_WORKTREE_PATH`, `LALPH_WORKTREE_PATH`, and `LALPH_WORKSPACE_NAME`.
When lalph creates or switches into a temporary worktree/workspace, it also
syncs shared `.lalph/config`, `.lalph/projects`, and `.lalph/hooks.yml` into
that execution directory.

Migration from `scripts/worktree-setup.sh`:

If `.lalph/hooks.yml` is missing, lalph still falls back to the legacy
`scripts/worktree-setup.sh`. Once `.lalph/hooks.yml` exists, it takes
precedence and the legacy setup script is ignored.

Before:

```bash
#!/usr/bin/env bash
set -euo pipefail

pnpm install
```

After:

```yaml
hooks:
  post-create:
    install: "pnpm install"
```

## Plan mode

Plan mode opens an editor so you can write a high-level plan. You can also pass
`--file` / `-f` with a markdown file path to skip the editor. On save (or file
read), lalph generates a specification under `--specs` and then creates PRD
tasks from it.

Use `--dangerous` to skip permission prompts during spec generation, and `--new`
to create a project before starting plan mode.
If you have multiple agent presets, plan commands prompt you to choose which
preset to run before launching the CLI agent.

```bash
lalph plan
lalph plan --file ./my-plan.md
lalph plan tasks .specs/my-spec.md
```

## Creating issues

`lalph issue` opens a new-issue template in your editor. When you save and close
the file, the issue is created in the current issue source.

Anything below the front matter is used as the issue description.

Front matter fields:

- `title`: short issue title
- `priority`: number (0 = none, 1 = urgent, 2 = high, 3 = normal, 4 = low)
- `estimate`: number of points, or `null`
- `blockedBy`: array of issue identifiers
- `autoMerge`: whether to mark this issue for auto-merge when applicable

```bash
lalph issue
lalph i
```

## Development

- Install dependencies: `pnpm install`
- Build the CLI: `pnpm build`
- Run validations: `pnpm check`
