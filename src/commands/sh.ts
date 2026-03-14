import { Command } from "effect/unstable/cli"
import { Effect, Layer } from "effect"
import { Worktree } from "../Worktree.ts"
import { layerProjectIdPrompt } from "../Projects.ts"
import { launchInteractiveShell } from "../shared/interactiveShell.ts"

export const commandSh = Command.make("sh").pipe(
  Command.withDescription(
    "Create a new execution directory for the active project and open a shell in it.",
  ),
  Command.withHandler(
    Effect.fnUntraced(
      function* () {
        const worktree = yield* Worktree

        yield* launchInteractiveShell(worktree.directory)
      },
      Effect.scoped,
      Effect.provide(
        Worktree.layerWorktree.pipe(Layer.provideMerge(layerProjectIdPrompt)),
      ),
    ),
  ),
)
