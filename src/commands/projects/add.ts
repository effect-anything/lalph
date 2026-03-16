import { Command } from "effect/unstable/cli"
import { addOrUpdateProject } from "../../Projects.ts"
import { CurrentIssueSource } from "../../CurrentIssueSource.ts"
import { Settings } from "../../Settings.ts"

export const commandProjectsAdd = Command.make("add").pipe(
  Command.withDescription(
    "Add a project and configure its execution settings (concurrency, execution mode, target branch, git flow, review agent, review completion) and issue source settings.",
  ),
  Command.withHandler(() => addOrUpdateProject()),
  Command.provide(Settings.layer),
  Command.provide(CurrentIssueSource.layer),
)
