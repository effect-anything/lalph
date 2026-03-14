import { Effect, Path, pipe } from "effect"
import { PromptGen } from "../PromptGen.ts"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Worktree } from "../Worktree.ts"
import type { CliAgentPreset } from "../domain/CliAgentPreset.ts"

export const agentPlanner = Effect.fnUntraced(function* (options: {
  readonly plan: string
  readonly specsDirectory: string
  readonly dangerous: boolean
  readonly preset: CliAgentPreset
}) {
  const pathService = yield* Path.Path
  const worktree = yield* Worktree
  const promptGen = yield* PromptGen
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  yield* pipe(
    options.preset.cliAgent.commandPlan({
      prompt: promptGen.planPrompt(options),
      prdFilePath: pathService.join(".lalph", "prd.yml"),
      dangerous: options.dangerous,
    }),
    ChildProcess.setCwd(worktree.directory),
    options.preset.withCommandPrefix,
    worktree.withRepositoryEnv,
    Effect.flatMap((command) => command.pipe(spawner.exitCode)),
  )
})
