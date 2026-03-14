import { Effect, Layer, Option } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import { Hooks } from "../../Hooks.ts"
import { layerProjectIdPrompt } from "../../Projects.ts"
import { hookTypes } from "../../domain/Hooks.ts"
import type { HookType } from "../../domain/Hooks.ts"
import { Worktree } from "../../Worktree.ts"

const hookType = Argument.choice("hook-type", hookTypes).pipe(
  Argument.withDescription(
    "Required. Hook section to dry-run: post-create, pre-merge, or post-switch",
  ),
)

export const commandHooksTest = Command.make("test", {
  hookType,
}).pipe(
  Command.withDescription(
    "Dry-run a hook section by resolving template variables and listing commands without executing them.",
  ),
  Command.withHandler(
    Effect.fnUntraced(
      function* ({ hookType }: { readonly hookType: HookType }) {
        const hooks = yield* Hooks
        const worktree = yield* Worktree
        const configPath = hooks.configPath(worktree.directory)
        const resolved = yield* hooks.resolveHook({
          directory: worktree.directory,
          hookType,
          templateValues: yield* worktree.getHookTemplateValues,
        })

        if (Option.isNone(resolved)) {
          console.log(`No hooks config found at ${configPath}`)
          return
        }

        if (resolved.value.length === 0) {
          console.log(`No ${hookType} hooks configured in ${configPath}`)
          return
        }

        console.log(`Dry run for ${hookType} hooks from ${configPath}`)
        console.log("Commands are not executed.")
        console.log("")

        for (const [index, command] of resolved.value.entries()) {
          console.log(`${index + 1}. ${command.hookName}`)
          console.log(`   ${command.interpolatedCommand}`)
        }
      },
      Effect.provide(
        Worktree.layerLocal.pipe(Layer.provideMerge(layerProjectIdPrompt)),
      ),
    ),
  ),
)
