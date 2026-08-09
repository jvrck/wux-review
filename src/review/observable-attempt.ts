export function observableAttemptChildName(
  baseChild: string,
  attempt: number,
): string {
  return attempt === 1 ? baseChild : `${baseChild}-a${attempt}`;
}

export function observableRetryAttempt(childName: string): number | undefined {
  const match = /-a([0-9]+)$/.exec(childName);
  if (match === null) return undefined;
  const attempt = Number(match[1]);
  return Number.isSafeInteger(attempt)
    && attempt >= 2
    && String(attempt) === match[1]
    ? attempt
    : undefined;
}

export function observableAttemptForChild(
  baseChild: string,
  childName: string,
): number | undefined {
  if (childName === baseChild) return 1;
  const attempt = observableRetryAttempt(childName);
  return attempt !== undefined
    && childName === observableAttemptChildName(baseChild, attempt)
    ? attempt
    : undefined;
}
