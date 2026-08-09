// Expected, user-facing failures. The CLI entry point prints the message on a
// single line and exits non-zero; unexpected errors keep their stack so real
// bugs stay visible. Mirrors wux's `WuxError`.
export class WuxReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WuxReviewError";
  }
}

export function errorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return oneLine(message);
}

// Keep every expected diagnostic on one trimmed output line.
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
