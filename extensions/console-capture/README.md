# console-capture

Captures console/stderr output during interactive Pi sessions so extension
startup failures and background logs do not corrupt the TUI redraw.

- Default log file: `~/.pi/agent/pi-console.log`
- Override log file: `PI_CONSOLE_CAPTURE_LOG=/path/to/log pi`
- Disable capture: `PI_CONSOLE_CAPTURE=0 pi`

The extension installs during `session_start`, before the other extensions in
this package. It intentionally does not patch `process.stdout.write` because the
TUI renderer owns stdout; it captures `console.log`/`console.info`/`console.warn`/
`console.error`/`console.debug` and direct `process.stderr.write` calls.
