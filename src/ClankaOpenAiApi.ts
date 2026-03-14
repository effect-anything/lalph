import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { AgentModelConfig } from "clanka/Agent"
import { Config, Effect, Layer } from "effect"
import { Model } from "effect/unstable/ai"
import type { LanguageModel } from "effect/unstable/ai/LanguageModel"
import type { HttpClient } from "effect/unstable/http/HttpClient"

type AgentOptions = typeof AgentModelConfig.Service
type ProviderOptions = OpenAiLanguageModel.Config["Service"]
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

const OPENAI_API_BASE_UR = Config.string("OPENAI_API_BASE_UR")
const OPENAI_API_KEY = Config.redacted("OPENAI_API_KEY")

const layerClient = Layer.orDie(
  Layer.unwrap(
    Effect.gen(function* () {
      const apiUrl = yield* OPENAI_API_BASE_UR
      const apiKey = yield* OPENAI_API_KEY

      return OpenAiClient.layer({
        apiUrl: apiUrl,
        apiKey: apiKey,
      })
    }),
  ),
)
export const model = (
  model: (string & {}) | OpenAiLanguageModel.Model,
  options?: ModelOptions | undefined,
): Model.Model<"openai", LanguageModel, HttpClient> => {
  const { providerConfig, supportsAssistantPrefill, supportsNoTools } =
    splitOptions(options)

  return Model.make(
    "openai",
    model,
    Layer.merge(
      OpenAiLanguageModel.layer({
        model,
        config: {
          ...providerConfig,
          store: false,
          reasoning: {
            ...providerConfig.reasoning,
            effort: providerConfig.reasoning?.effort ?? "medium",
            summary: "auto",
          },
        },
      }),
      AgentModelConfig.layer({
        systemPromptTransform: (system, effect) =>
          OpenAiLanguageModel.withConfigOverride(effect, {
            instructions: system,
          }),
        supportsAssistantPrefill: supportsAssistantPrefill ?? true,
        supportsNoTools: supportsNoTools ?? true,
      }),
    ).pipe(Layer.provide(layerClient)),
  )
}
