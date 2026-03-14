import { spawnSync } from "node:child_process"
import { Effect, PlatformError } from "effect"

const terminalResetSequence =
  "\u001b[?25h" + "\u001b[?1049l" + "\u001b[?1l" + "\u001b[?2004l"

const restoreTerminalState = () => {
  // Interactive shells must not inherit prompt/raw-mode terminal state.
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false)
  }

  if (process.stdout.isTTY) {
    process.stdout.write(terminalResetSequence)
  }

  if (process.platform !== "win32") {
    try {
      spawnSync("stty", ["sane"], {
        stdio: ["inherit", "ignore", "ignore"],
      })
    } catch {
      // Best-effort terminal recovery for interactive shells.
    }
  }
}

export const launchInteractiveShell = Effect.fnUntraced(function* (
  cwd: string,
) {
  const shell = process.env.SHELL || "/bin/bash"

  yield* Effect.sync(restoreTerminalState)

  return yield* Effect.try({
    try: () => {
      const result = spawnSync(shell, [], {
        cwd,
        env: process.env,
        stdio: "inherit",
      })

      if (result.error) {
        throw result.error
      }

      return result.status ?? 1
    },
    catch: (cause) =>
      PlatformError.badArgument({
        cause,
        description: `Failed to launch interactive shell: ${shell}`,
        method: "launchInteractiveShell",
        module: "interactiveShell",
      }),
  }).pipe(Effect.ensuring(Effect.sync(restoreTerminalState)))
})
