import { Agent, OutputFormatter } from "clanka"
import { Duration, Effect, Layer, Stdio, Stream } from "effect"
import { TaskChooseTools, TaskTools, TaskToolsHandlers } from "./TaskTools.ts"
import { ClankaModels } from "./ClankaModels.ts"
import { withStallTimeout } from "./shared/stream.ts"
import { NodeHttpClient } from "@effect/platform-node"
import type { Prompt } from "effect/unstable/ai"

export const ClankaMuxerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const muxer = yield* OutputFormatter.Muxer
    const stdio = yield* Stdio.Stdio
    yield* muxer.output.pipe(Stream.run(stdio.stdout()), Effect.forkScoped)
  }),
).pipe(Layer.provideMerge(OutputFormatter.layerMuxer(OutputFormatter.pretty)))

export const runClanka = Effect.fnUntraced(
  function* (options: {
    readonly directory: string
    readonly model: string
    readonly prompt: Prompt.RawInput
    readonly system?: string | undefined
    readonly stallTimeout?: Duration.Input | undefined
    readonly steer?: Stream.Stream<string> | undefined
    readonly withChoose?: boolean | undefined
  }) {
    const muxer = yield* OutputFormatter.Muxer
    const agent = yield* Agent.Agent

    const output = yield* agent.send({
      prompt: options.prompt,
      system: options.system,
    })

    yield* muxer.add(output)

    let stream = options.stallTimeout
      ? withStallTimeout(options.stallTimeout)(output)
      : output

    if (options.steer) {
      yield* options.steer.pipe(
        Stream.switchMap(
          Effect.fnUntraced(function* (message) {
            yield* Effect.log(`Received steer message: ${message}`)
            yield* agent.steer(message)
          }, Stream.fromEffectDrain),
        ),
        Stream.runDrain,
        Effect.forkScoped,
      )
    }

    return yield* stream.pipe(
      Stream.runDrain,
      Effect.as(""),
      Effect.catchTag("AgentFinished", (e) => Effect.succeed(e.summary)),
    )
  },
  Effect.scoped,
  (effect, options) =>
    Effect.provide(
      effect,
      Agent.layerLocal({
        directory: options.directory,
        tools: options.withChoose ? TaskChooseTools : TaskTools,
      }).pipe(Layer.merge(ClankaModels.get(options.model))),
    ),
  Effect.provide([NodeHttpClient.layerUndici, TaskToolsHandlers]),
)
