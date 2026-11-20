// GitHub Actions exports CI=true, and Ink reads it through `is-in-ci` to switch
// off live painting: in CI it never repaints the main output, so a test that
// reads the current frame sees an empty string until unmount. The TUI tests
// stand in for an interactive terminal (they hand Ink a fake TTY stream and
// drive it with keystrokes), so they need the interactive renderer.
//
// The markers are removed here, in a setup file, because `is-in-ci` snapshots
// `process.env` when it is first imported — deleting them later has no effect.
delete process.env.CI;
delete process.env.CONTINUOUS_INTEGRATION;
