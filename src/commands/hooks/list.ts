import { Effect, Layer, Option } from "effect"
import { Command } from "effect/unstable/cli"
import { Hooks } from "../../Hooks.ts"
import { layerProjectIdPrompt } from "../../Projects.ts"
import { hookTypes } from "../../domain/Hooks.ts"
import { Worktree } from "../../Worktree.ts"

const formatSection = (
  title: string,
  commands: ReadonlyArray<readonly [string, string]>,
) =>
  [`${title}:`, ...commands.map(([name, command]) => `  ${name}: ${command}`)]
    .join("\n")
    .trimEnd()

export const commandHooksList = Command.make("list").pipe(
  Command.withDescription(
    "Show the hooks configured in .lalph/hooks.yml for the selected project.",
  ),
  Command.withHandler(
    Effect.fnUntraced(
      function* () {
        const hooks = yield* Hooks
        const worktree = yield* Worktree
        const configPath = hooks.configPath(worktree.directory)
        const config = yield* hooks.loadConfig(worktree.directory)

        if (Option.isNone(config)) {
          console.log(`No hooks config found at ${configPath}`)
          return
        }

        const sections = hookTypes.flatMap((hookType) => {
          const hookSection = config.value.hooks[hookType]
          if (!hookSection) {
            return []
          }
          const commands = Object.entries(hookSection).sort(([left], [right]) =>
            left.localeCompare(right),
          )
          if (commands.length === 0) {
            return []
          }
          return [formatSection(hookType, commands)]
        })

        if (sections.length === 0) {
          console.log(
            `Hooks config found at ${configPath}, but no hooks are set.`,
          )
          return
        }

        console.log(`Hooks config: ${configPath}`)
        console.log("")
        console.log(sections.join("\n\n"))
      },
      Effect.provide(
        Worktree.layerLocal.pipe(Layer.provideMerge(layerProjectIdPrompt)),
      ),
    ),
  ),
)
