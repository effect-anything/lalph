// oxlint-disable typescript/no-explicit-any
import { NodeHttpClient, NodeSocket } from "@effect/platform-node"
import { Agent, Codex, Copilot } from "clanka"
import { Effect, flow, Layer, Schema } from "effect"
import * as AnthropicApi from "./ClankaAnthropicApi.ts"
import * as OpenAiApi from "./ClankaOpenAiApi.ts"
import { layerKvs } from "./Kvs.ts"

export const ModelServices = NodeHttpClient.layerUndici.pipe(
  Layer.merge(layerKvs),
)

const Reasoning = Schema.Literals(["low", "medium", "high", "xhigh"])
const Provider = Schema.Literals([
  "openai",
  "copilot",
  "openai-api",
  "anthropic-api",
])

const parseInput = flow(
  Schema.decodeUnknownEffect(
    Schema.Tuple([Provider, Schema.String, Reasoning]),
  ),
  Effect.orDie,
)

export const layerClankaModel = (input: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const [provider, model, reasoning] = yield* parseInput(input.split("/"))
      const layer = resolve(provider, model, reasoning)
      return Layer.merge(
        layer,
        Agent.layerSubagentModel(
          reasoning === "low"
            ? layer
            : resolveSubagent(
                provider,
                model,
                reasoning === "medium" ? "low" : "medium",
              ),
        ),
      )
    }),
  )

const resolve = (
  provider: typeof Provider.Type,
  model: string,
  reasoning: typeof Reasoning.Type,
) => {
  switch (provider) {
    case "openai": {
      return Codex.modelWebSocket(model, {
        reasoning: {
          effort: reasoning,
        },
      }).pipe(
        Layer.provide(NodeSocket.layerWebSocketConstructorWS),
        Layer.provide(Codex.layerClient),
      )
    }
    case "copilot": {
      return Copilot.model(model, {
        ...reasoningToCopilotConfig(model, reasoning),
      }).pipe(Layer.provide(Copilot.layerClient))
    }
    case "openai-api": {
      return OpenAiApi.model(model, {
        reasoning: {
          effort: reasoning,
        },
      })
    }
    case "anthropic-api": {
      return AnthropicApi.model(model, {
        cache_control: {
          type: "ephemeral",
        },
        output_config: {
          effort: reasoningToAnthropicEffort(reasoning),
        },
      })
    }
  }
}

const resolveSubagent = (
  provider: typeof Provider.Type,
  model: string,
  reasoning: typeof Reasoning.Type,
) => {
  switch (provider) {
    case "openai": {
      return Codex.modelWebSocket("gpt-5.4-mini", {
        reasoning: {
          effort: "high",
        },
      }).pipe(
        Layer.provide(NodeSocket.layerWebSocketConstructorWS),
        Layer.provide(Codex.layerClient),
      )
    }
    case "copilot": {
      return Copilot.model(model, {
        ...reasoningToCopilotConfig(model, reasoning),
      }).pipe(Layer.provide(Copilot.layerClient))
    }
    case "openai-api": {
      return OpenAiApi.model(model, {
        reasoning: {
          effort: reasoning,
        },
      })
    }
    case "anthropic-api": {
      return AnthropicApi.model(model, {
        cache_control: {
          type: "ephemeral",
        },
        output_config: {
          effort: reasoningToAnthropicEffort(reasoning),
        },
      })
    }
  }
}

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

const reasoningToAnthropicEffort = (reasoning: typeof Reasoning.Type) => {
  switch (reasoning) {
    case "xhigh":
      return "high" as const
    default:
      return reasoning
  }
}
