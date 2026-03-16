import { Command } from "effect/unstable/cli"
import { commandProjectsLs } from "./projects/ls.ts"
import { commandProjectsAdd } from "./projects/add.ts"
import { commandProjectsRm } from "./projects/rm.ts"
import { commandProjectsEdit } from "./projects/edit.ts"
import { commandProjectsToggle } from "./projects/toggle.ts"

const subcommands = Command.withSubcommands([
  commandProjectsLs,
  commandProjectsAdd,
  commandProjectsEdit,
  commandProjectsToggle,
  commandProjectsRm,
])

export const commandProjects = Command.make("projects").pipe(
  Command.withDescription(
    "Manage projects and their execution settings (enabled state, concurrency, execution mode, target branch, git flow, review agent, review completion). Use 'ls' to inspect and 'add', 'edit', or 'toggle' to configure.",
  ),
  Command.withAlias("p"),
  subcommands,
)
