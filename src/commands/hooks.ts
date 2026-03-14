import { Command } from "effect/unstable/cli"
import { commandHooksList } from "./hooks/list.ts"
import { commandHooksTest } from "./hooks/test.ts"

const subcommands = Command.withSubcommands([
  commandHooksList,
  commandHooksTest,
])

export const commandHooks = Command.make("hooks").pipe(
  Command.withDescription(
    "Inspect project lifecycle hooks from .lalph/hooks.yml. Use 'list' to view configured commands and 'test <hook-type>' to preview interpolated commands without executing them.",
  ),
  subcommands,
)
