// oxlint-disable typescript/no-explicit-any
import { NodeHttpClient } from "@effect/platform-node"
import { Codex, Copilot } from "clanka"
import { Effect, flow, Layer, LayerMap, Schema } from "effect"
import { layerKvs } from "./Kvs.ts"

export const ModelServices = NodeHttpClient.layerUndici.pipe(
  Layer.merge(layerKvs),
)

const Reasoning = Schema.Literals(["low", "medium", "high", "xhigh"])
const parseInput = flow(
  Schema.decodeUnknownEffect(
    Schema.Tuple([
      Schema.Literals(["openai", "copilot"]),
      Schema.String,
      Reasoning,
    ]),
  ),
  Effect.orDie,
)

export const clankaSubagent = Effect.fnUntraced(function* (
  models: ClankaModels["Service"],
  input: string,
) {
  const [provider, model] = yield* parseInput(input.split("/"))
  return models.get(`${provider}/${model}/low`)
}, Layer.unwrap)

export class ClankaModels extends LayerMap.Service<ClankaModels>()(
  "lalph/ClankaModels",
  {
    dependencies: [ModelServices],
    lookup: Effect.fnUntraced(function* (input: string) {
      const [provider, model, reasoning] = yield* parseInput(input.split("/"))
      switch (provider) {
        case "openai": {
          return Codex.model(model, {
            reasoning: {
              effort: reasoning,
            },
          })
        }
        case "copilot": {
          return Copilot.model(model, {
            ...reasoningToCopilotConfig(model, reasoning),
          })
        }
      }
    }, Layer.unwrap),
  },
) {}

const reasoningToCopilotConfig = (
  model: string,
  reasoning: typeof Reasoning.Type,
) => {
  if (model.startsWith("claude")) {
    switch (reasoning) {
      case "low":
        return {}
      case "medium":
        return { reasoningEffort: 4000 }
      case "high":
        return { thinking_budget: 16000 }
      case "xhigh":
        return { thinking_budget: 31999 }
    }
  }
  return { reasoningEffort: reasoning }
}
