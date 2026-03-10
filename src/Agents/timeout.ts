import { Duration, Effect, Path, pipe } from "effect"
import { PromptGen } from "../PromptGen.ts"
import { ChildProcess } from "effect/unstable/process"
import { Worktree } from "../Worktree.ts"
import type { PrdIssue } from "../domain/PrdIssue.ts"
import type { CliAgentPreset } from "../domain/CliAgentPreset.ts"
import { ExitCode } from "effect/unstable/process/ChildProcessSpawner"
import { runClanka } from "../Clanka.ts"

export const agentTimeout = Effect.fnUntraced(function* (options: {
  readonly specsDirectory: string
  readonly stallTimeout: Duration.Duration
  readonly preset: CliAgentPreset
  readonly task: PrdIssue
}) {
  const pathService = yield* Path.Path
  const worktree = yield* Worktree
  const promptGen = yield* PromptGen

  // use clanka
  if (!options.preset.cliAgent.command) {
    yield* runClanka({
      directory: worktree.directory,
      model: options.preset.extraArgs.join(" "),
      system: promptGen.systemClanka(options),
      prompt: promptGen.promptTimeoutClanka({
        taskId: options.task.id!,
        specsDirectory: options.specsDirectory,
      }),
      stallTimeout: options.stallTimeout,
    })
    return ExitCode(0)
  }

  const timeoutCommand = pipe(
    options.preset.cliAgent.command({
      prompt: promptGen.promptTimeout({
        taskId: options.task.id!,
        specsDirectory: options.specsDirectory,
      }),
      prdFilePath: pathService.join(".lalph", "prd.yml"),
      extraArgs: options.preset.extraArgs,
    }),
    ChildProcess.setCwd(worktree.directory),
    options.preset.withCommandPrefix,
  )
  return yield* timeoutCommand.pipe(
    worktree.execWithStallTimeout({
      cliAgent: options.preset.cliAgent,
      stallTimeout: options.stallTimeout,
    }),
  )
})
