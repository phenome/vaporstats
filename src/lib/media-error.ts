const MAX_ERROR_LENGTH = 256;

/** `error`'s message on one bounded line, with every configured secret and bearer token redacted. */
export function boundedMediaError(error: unknown, secrets: readonly (string | undefined)[] = []): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join("[redacted]");
  }
  return message
    .replace(/[\r\n]+/g, " ")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(?:api[_-]?key|token|secret)\s*[:=]\s*\S+/gi, "[redacted]")
    .slice(0, MAX_ERROR_LENGTH);
}
