import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { AgentModelConfig } from "clanka/Agent"
import { Config, Effect, Layer } from "effect"
import { Model } from "effect/unstable/ai"
import type { LanguageModel } from "effect/unstable/ai/LanguageModel"
import type { HttpClient } from "effect/unstable/http/HttpClient"

type AgentOptions = typeof AgentModelConfig.Service
type ProviderOptions = AnthropicLanguageModel.Config["Service"]
type ModelOptions = ProviderOptions & AgentOptions

const splitOptions = (options?: ModelOptions) => {
  const {
    supportsAssistantPrefill,
    supportsNoTools,
    systemPromptTransform: _systemPromptTransform,
    ...providerConfig
  } = options ?? {}

  return {
    providerConfig,
    supportsAssistantPrefill,
    supportsNoTools,
  }
}

const ANTHROPIC_API_BASE_URL = Config.string("ANTHROPIC_API_BASE_URL")
const ANTHROPIC_API_KEY = Config.redacted("ANTHROPIC_API_KEY")

const layerClient = Layer.orDie(
  Layer.unwrap(
    Effect.gen(function* () {
      const apiUrl = yield* ANTHROPIC_API_BASE_URL
      const apiKey = yield* ANTHROPIC_API_KEY

      return AnthropicClient.layer({
        apiUrl: apiUrl,
        apiKey: apiKey,
      })
    }),
  ),
)

export const model = (
  model: (string & {}) | AnthropicLanguageModel.Model,
  options?: ModelOptions | undefined,
): Model.Model<"anthropic", LanguageModel, HttpClient> => {
  const { providerConfig, supportsAssistantPrefill, supportsNoTools } =
    splitOptions(options)

  return Model.make(
    "anthropic",
    model,
    Layer.merge(
      AnthropicLanguageModel.layer({
        model,
        config: providerConfig,
      }),
      AgentModelConfig.layer({
        systemPromptTransform: (system, effect) =>
          AnthropicLanguageModel.withConfigOverride(effect, {
            system: [{ type: "text", text: system }],
          }),
        supportsAssistantPrefill: supportsAssistantPrefill ?? false,
        supportsNoTools: supportsNoTools ?? false,
      }),
    ).pipe(Layer.provide(layerClient)),
  )
}
