export function isObjectId(value: unknown): value is string {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
}

export function normalizeObjectId(value: string): string {
  return value.toLowerCase();
}
