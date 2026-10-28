/**
 * Run a headless console program without a visible window.
 *
 * On Windows, a console program started from a process with no console can get
 * its own console, and Windows Terminal shows it as a new window. Bun.spawn with
 * `windowsHide: true` prevents that. Tested: a Bun child started from a detached
 * parent opened a window without the option and none with it.
 *
 * Feeds `input` on stdin, collects stdout and stderr, and kills the child after
 * `timeoutMs`. Resolves with the exit code, or rejects if the program cannot start.
 */

export type HiddenRunResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
}

export async function runHidden(
  command: string,
  args: string[],
  opts: { env?: Record<string, string>; cwd?: string; input?: string; timeoutMs: number },
): Promise<HiddenRunResult> {
  const proc = Bun.spawn([command, ...args], {
    cwd: opts.cwd,
    env: opts.env,
    stdin: new Blob([opts.input ?? ""]),
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })

  let timedOut = false
  const killTimer = setTimeout(() => {
    timedOut = true
    try { proc.kill("SIGKILL") } catch { /* already gone */ }
  }, opts.timeoutMs)

  // A grandchild can keep the pipes open after the kill. The deadline stops that from hanging the caller.
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<HiddenRunResult>((resolve) => {
    deadlineTimer = setTimeout(
      () => resolve({ stdout: "", stderr: "pipe drain deadline exceeded", exitCode: null, timedOut: true }),
      opts.timeoutMs + 20_000,
    )
  })
  const collected = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).then(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode, timedOut }))
  // If the deadline wins, a late failure here must not surface as an unhandled rejection.
  collected.catch(() => {})

  try {
    return await Promise.race([collected, deadline])
  } finally {
    clearTimeout(killTimer)
    if (deadlineTimer) clearTimeout(deadlineTimer)
  }
}
