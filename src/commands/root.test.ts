import assert from "node:assert/strict"
import test from "node:test"
import { PrdIssue } from "../domain/PrdIssue.ts"
import { shouldAutoSetIssueDone } from "./root.ts"

const makeIssue = (state: PrdIssue["state"]) =>
  new PrdIssue({
    autoMerge: false,
    blockedBy: [],
    description: "test",
    estimate: null,
    id: "AUT-1",
    priority: 2,
    state,
    title: "Test task",
  })

test("shouldAutoSetIssueDone only advances in-review tasks in auto-done mode", () => {
  assert.equal(
    shouldAutoSetIssueDone({
      reviewCompletion: "auto-done",
      task: makeIssue("in-review"),
    }),
    true,
  )
  assert.equal(
    shouldAutoSetIssueDone({
      reviewCompletion: "manual",
      task: makeIssue("in-review"),
    }),
    false,
  )
  assert.equal(
    shouldAutoSetIssueDone({
      reviewCompletion: "auto-done",
      task: makeIssue("todo"),
    }),
    false,
  )
  assert.equal(
    shouldAutoSetIssueDone({
      reviewCompletion: "auto-done",
      task: null,
    }),
    false,
  )
})
