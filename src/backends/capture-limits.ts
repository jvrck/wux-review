// Reviewer diagnostics share one fixed stderr policy across direct and
// observable execution so tests and transports cannot drift independently.
export const REVIEWER_STDERR_TAIL_BYTES = 256 * 1024;
