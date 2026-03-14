import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { Effect, Layer, Redacted } from "effect"
import { AgentModelConfig } from "clanka/Agent"
import { Model } from "effect/unstable/ai"
import type { LanguageModel } from "effect/unstable/ai/LanguageModel"
import type { HttpClient } from "effect/unstable/http/HttpClient"

const defaultApiUrl = "http://localhost:3333/api"

type AgentOptions = typeof AgentModelConfig.Service
type ProviderOptions = AnthropicLanguageModel.Config["Service"]
type ModelOptions = ProviderOptions & AgentOptions

const normalizeApiUrl = (apiUrl: string) =>
  apiUrl.replace(/\/v1(?:\/messages)?\/?$/, "")

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
      process.env.CLANKA_ANTHROPIC_API_BASE_URL?.trim() || defaultApiUrl
    const apiKey =
      process.env.CLANKA_ANTHROPIC_API_KEY?.trim() ??
      "cr_e8609ef50af448b1a38a08af92ebc6c5d7589426597c1d12ef130ab832d50270"

    return AnthropicClient.layer({
      apiUrl: normalizeApiUrl(apiUrl),
      apiKey: apiKey ? Redacted.make(apiKey) : undefined,
    })
  }),
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
