import {
  Array,
  Data,
  Duration,
  Effect,
  Option,
  Schema,
  ScopedCache,
  ServiceMap,
  Stream,
  SubscriptionRef,
  pipe,
} from "effect"
import type { PrdIssue } from "./domain/PrdIssue.ts"
import type { ProjectId } from "./domain/Project.ts"
import type { CurrentProjectId, Settings } from "./Settings.ts"
import type { CliAgentPreset } from "./domain/CliAgentPreset.ts"
import type { Environment } from "effect/unstable/cli/Prompt"
import type { QuitError } from "effect/Terminal"

export type IssuesChange = Data.TaggedEnum<{
  Internal: { issues: ReadonlyArray<PrdIssue> }
  External: { issues: ReadonlyArray<PrdIssue> }
}>
export const IssuesChange = Data.taggedEnum<IssuesChange>()

export class IssueSource extends ServiceMap.Service<
  IssueSource,
  {
    readonly ref: (
      projectId: ProjectId,
    ) => Effect.Effect<SubscriptionRef.SubscriptionRef<IssuesChange>>

    readonly issues: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<PrdIssue>, IssueSourceError>

    readonly findById: (
      projectId: ProjectId,
      issueId: string,
    ) => Effect.Effect<PrdIssue | null, IssueSourceError>

    readonly createIssue: (
      projectId: ProjectId,
      issue: PrdIssue,
    ) => Effect.Effect<{ id: string; url: string }, IssueSourceError>

    readonly updateIssue: (options: {
      readonly projectId: ProjectId
      readonly issueId: string
      readonly title?: string | undefined
      readonly description?: string | undefined
      readonly state?: PrdIssue["state"] | undefined
      readonly blockedBy?: ReadonlyArray<string> | undefined
      readonly autoMerge?: boolean | undefined
    }) => Effect.Effect<void, IssueSourceError>

    readonly cancelIssue: (
      projectId: ProjectId,
      issueId: string,
    ) => Effect.Effect<void, IssueSourceError>

    readonly reset: Effect.Effect<
      void,
      IssueSourceError,
      CurrentProjectId | Settings
    >
    readonly settings: (
      projectId: ProjectId,
    ) => Effect.Effect<void, IssueSourceError>
    readonly info: (
      projectId: ProjectId,
    ) => Effect.Effect<void, IssueSourceError>

    readonly issueCliAgentPreset: (
      issue: PrdIssue,
    ) => Effect.Effect<Option.Option<CliAgentPreset>, IssueSourceError>
    readonly updateCliAgentPreset: (
      preset: CliAgentPreset,
    ) => Effect.Effect<
      CliAgentPreset,
      IssueSourceError | QuitError,
      Environment
    >
    readonly cliAgentPresetInfo: (
      preset: CliAgentPreset,
    ) => Effect.Effect<void, IssueSourceError>

    readonly ensureInProgress: (
      projectId: ProjectId,
      issueId: string,
    ) => Effect.Effect<void, IssueSourceError>
  }
>()("lalph/IssueSource") {
  static make(impl: Omit<IssueSource["Service"], "ref" | "findById">) {
    return Effect.gen(function* () {
      const refs = yield* ScopedCache.make({
        lookup: Effect.fnUntraced(function* (projectId: ProjectId) {
          const ref = yield* SubscriptionRef.make<IssuesChange>(
            IssuesChange.Internal({
              issues: yield* pipe(
                impl.issues(projectId),
                Effect.orElseSucceed(Array.empty),
              ),
            }),
          )

          yield* SubscriptionRef.changes(ref).pipe(
            Stream.switchMap((_) =>
              impl.issues(projectId).pipe(
                Effect.tap((issues) =>
                  SubscriptionRef.set(ref, IssuesChange.External({ issues })),
                ),
                Effect.ignoreCause,
                Effect.delay(Duration.seconds(30)),
                Stream.fromEffectDrain,
              ),
            ),
            Stream.runDrain,
            Effect.forkScoped,
          )

          return ref
        }),
        capacity: Number.MAX_SAFE_INTEGER,
      })

      const update = Effect.fnUntraced(function* (
        projectId: ProjectId,
        issues: ReadonlyArray<PrdIssue>,
      ) {
        const ref = yield* ScopedCache.get(refs, projectId)
        yield* SubscriptionRef.set(ref, IssuesChange.Internal({ issues }))
      })

      const updateIssues = (projectId: ProjectId) =>
        pipe(
          impl.issues(projectId),
          Effect.tap((issues) => update(projectId, issues)),
        )

      return IssueSource.of({
        ...impl,
        ref: (projectId) => ScopedCache.get(refs, projectId),
        issues: updateIssues,
        findById: Effect.fnUntraced(function* (projectId, issueId) {
          const ref = yield* ScopedCache.get(refs, projectId)
          const { issues } = yield* SubscriptionRef.get(ref)
          return issues.find((issue) => issue.id === issueId) ?? null
        }),
        createIssue: (projectId, issue) =>
          pipe(
            impl.createIssue(projectId, issue),
            Effect.tap(updateIssues(projectId)),
          ),
        updateIssue: (options) =>
          pipe(
            impl.updateIssue(options),
            Effect.tap(updateIssues(options.projectId)),
          ),
        cancelIssue: (projectId, issueId) =>
          pipe(
            impl.cancelIssue(projectId, issueId),
            Effect.tap(updateIssues(projectId)),
          ),
      })
    })
  }
}

export class IssueSourceError extends Schema.ErrorClass<IssueSourceError>(
  "lalph/IssueSourceError",
)({
  _tag: Schema.tag("IssueSourceError"),
  cause: Schema.Defect,
}) {
  readonly message = "An error occurred in the IssueSource"
}
