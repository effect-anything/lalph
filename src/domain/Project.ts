import { Schema } from "effect"
import { withEncodeDefault } from "../shared/schema.ts"

export const ProjectId = Schema.String.pipe(Schema.brand("lalph/ProjectId"))
export type ProjectId = typeof ProjectId.Type
export const ProjectCheckoutMode = Schema.Literals(["worktree", "in-place"])
export type ProjectCheckoutMode = typeof ProjectCheckoutMode.Type
export const ProjectReviewCompletion = Schema.Literals(["manual", "auto-done"])
export type ProjectReviewCompletion = typeof ProjectReviewCompletion.Type

export class Project extends Schema.Class<Project>("lalph/Project")({
  id: ProjectId,
  enabled: Schema.Boolean,
  targetBranch: Schema.Option(Schema.String),
  concurrency: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  checkoutMode: ProjectCheckoutMode.pipe(withEncodeDefault(() => "worktree")),
  gitFlow: Schema.Literals(["pr", "commit"]),
  reviewAgent: Schema.Boolean,
  reviewCompletion: ProjectReviewCompletion.pipe(
    withEncodeDefault(() => "manual"),
  ),
}) {}
