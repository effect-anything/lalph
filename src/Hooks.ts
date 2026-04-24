import {
  Data,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  PlatformError,
  Schema,
  ServiceMap,
} from "effect"
import * as Yaml from "yaml"
import { type HookType, HooksConfig } from "./domain/Hooks.ts"

export class HooksConfigParseError extends Data.TaggedError(
  "HooksConfigParseError",
)<{
  readonly message: string
  readonly cause: unknown
}> {}

export class HookCommandFailedError extends Data.TaggedError(
  "HookCommandFailedError",
)<{
  readonly hookType: HookType
  readonly hookName: string
  readonly command: string
  readonly exitCode: number
}> {
  readonly message = `Hook "${this.hookType}.${this.hookName}" failed with exit code ${this.exitCode}`
}

export type HookTemplateValues = Readonly<Record<string, string | undefined>>

export interface ResolvedHookCommand {
  readonly hookName: string
  readonly command: string
  readonly interpolatedCommand: string
}

const hookTemplatePattern = /{{\s*([a-z_]+)\s*}}/g

export const interpolateTemplate = (
  template: string,
  values: HookTemplateValues,
) =>
  template.replaceAll(
    hookTemplatePattern,
    (_match, key: string) => values[key] ?? "",
  )

const parseHooksConfig = (content: string) =>
  Effect.try({
    try: () => Yaml.parse(content),
    catch: (cause) =>
      new HooksConfigParseError({
        message:
          cause instanceof Error ? cause.message : "Failed to parse hooks.yml",
        cause,
      }),
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(HooksConfig)))

const getConfigPath = (
  pathService: { readonly join: (...paths: Array<string>) => string },
  directory: string,
) => pathService.join(directory, ".lalph", "hooks.yml")

const getConfigPaths = (
  pathService: { readonly join: (...paths: Array<string>) => string },
  directory: string,
  fallbackDirectory: string | undefined,
) => {
  const primaryPath = getConfigPath(pathService, directory)
  if (fallbackDirectory === undefined || fallbackDirectory === directory) {
    return [primaryPath] as const
  }
  return [primaryPath, getConfigPath(pathService, fallbackDirectory)] as const
}

const loadHooksConfig = Effect.fnUntraced(function* (configPath: string) {
  const fs = yield* FileSystem.FileSystem

  if (!(yield* fs.exists(configPath))) {
    return Option.none<typeof HooksConfig.Type>()
  }

  const content = yield* fs.readFileString(configPath)
  return Option.some(yield* parseHooksConfig(content))
})

const sortHookCommands = (hookSection: HooksConfig["hooks"][HookType]) =>
  Object.entries(hookSection ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  )

export class Hooks extends ServiceMap.Service<
  Hooks,
  {
    readonly configPath: (directory: string) => string
    readonly loadConfig: (
      directory: string,
      fallbackDirectory?: string,
    ) => ReturnType<typeof loadHooksConfig>
    readonly resolveHook: (options: {
      readonly directory: string
      readonly fallbackDirectory?: string
      readonly hookType: HookType
      readonly templateValues: HookTemplateValues
    }) => Effect.Effect<
      Option.Option<ReadonlyArray<ResolvedHookCommand>>,
      HooksConfigParseError | PlatformError.PlatformError | Schema.SchemaError,
      FileSystem.FileSystem
    >
    readonly executeHook: (options: {
      readonly directory: string
      readonly fallbackDirectory?: string
      readonly hookType: HookType
      readonly runCommand: (
        command: string,
      ) => Effect.Effect<number, PlatformError.PlatformError>
      readonly templateValues: HookTemplateValues
    }) => Effect.Effect<
      boolean,
      | HooksConfigParseError
      | HookCommandFailedError
      | PlatformError.PlatformError
      | Schema.SchemaError,
      FileSystem.FileSystem
    >
    readonly interpolateTemplate: typeof interpolateTemplate
  }
>()("lalph/Hooks", {
  make: Effect.gen(function* () {
    const pathService = yield* Path.Path
    const configPath = (directory: string) =>
      getConfigPath(pathService, directory)
    const loadConfig = Effect.fnUntraced(function* (
      directory: string,
      fallbackDirectory?: string,
    ) {
      for (const path of getConfigPaths(
        pathService,
        directory,
        fallbackDirectory,
      )) {
        const config = yield* loadHooksConfig(path)
        if (Option.isSome(config)) {
          return config
        }
      }
      return Option.none<typeof HooksConfig.Type>()
    })
    const resolveHook = Effect.fnUntraced(function* (options: {
      readonly directory: string
      readonly fallbackDirectory?: string
      readonly hookType: HookType
      readonly templateValues: HookTemplateValues
    }) {
      const config = yield* loadConfig(
        options.directory,
        options.fallbackDirectory,
      )

      if (Option.isNone(config)) {
        return Option.none<ReadonlyArray<ResolvedHookCommand>>()
      }

      return Option.some(
        sortHookCommands(config.value.hooks[options.hookType]).map(
          ([hookName, command]) => ({
            command,
            hookName,
            interpolatedCommand: interpolateTemplate(
              command,
              options.templateValues,
            ),
          }),
        ),
      )
    })
    const executeHook = Effect.fnUntraced(function* (options: {
      readonly directory: string
      readonly fallbackDirectory?: string
      readonly hookType: HookType
      readonly runCommand: (
        command: string,
      ) => Effect.Effect<number, PlatformError.PlatformError>
      readonly templateValues: HookTemplateValues
    }) {
      const resolvedCommands = yield* resolveHook(options)
      if (Option.isNone(resolvedCommands)) {
        return false
      }
      for (const resolvedCommand of resolvedCommands.value) {
        const exitCode = yield* options.runCommand(
          resolvedCommand.interpolatedCommand,
        )

        if (exitCode !== 0) {
          yield* Effect.logError(
            `Hook "${options.hookType}.${resolvedCommand.hookName}" failed with exit code ${exitCode}`,
          )
          return yield* new HookCommandFailedError({
            command: resolvedCommand.interpolatedCommand,
            exitCode,
            hookName: resolvedCommand.hookName,
            hookType: options.hookType,
          })
        }
      }

      return true
    })

    return {
      configPath,
      executeHook,
      loadConfig,
      interpolateTemplate,
      resolveHook,
    } as const
  }).pipe(Effect.withSpan("Hooks.build")),
}) {
  static layer = Layer.effect(this, this.make)
}
