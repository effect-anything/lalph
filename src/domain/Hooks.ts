import { Schema } from "effect"

export const HookCommand = Schema.String
export type HookCommand = typeof HookCommand.Type

export const HookSection = Schema.Record(Schema.String, HookCommand)
export type HookSection = typeof HookSection.Type

export const hookTypes = ["post-create", "pre-merge", "post-switch"] as const

export const HookType = Schema.Literals(hookTypes)
export type HookType = typeof HookType.Type

export const HooksConfig = Schema.Struct({
  hooks: Schema.Struct({
    "post-create": Schema.optional(HookSection),
    "pre-merge": Schema.optional(HookSection),
    "post-switch": Schema.optional(HookSection),
  }),
})
export type HooksConfig = typeof HooksConfig.Type
