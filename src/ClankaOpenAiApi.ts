import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { Effect, Layer, Redacted } from "effect"
import { AgentModelConfig } from "clanka/Agent"
import { Model } from "effect/unstable/ai"
import type { LanguageModel } from "effect/unstable/ai/LanguageModel"
import type { HttpClient } from "effect/unstable/http/HttpClient"

const defaultApiUrl = "http://localhost:3333/openai"

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

const layerClient = Layer.unwrap(
  Effect.sync(() => {
    const apiUrl =
      process.env.CLANKA_OPENAI_API_BASE_URL?.trim() || defaultApiUrl
    const apiKey =
      process.env.CLANKA_OPENAI_API_KEY?.trim() ??
      "cr_88dbffab23ff47b04363a3a2720521ea4eaa5193816a64a8c396157540135c10"

    return OpenAiClient.layer({
      apiUrl,
      apiKey: apiKey ? Redacted.make(apiKey) : undefined,
    })
  }),
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
