const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
  log?: (message: string) => void;
}

export class HttpStatusError extends Error {
  readonly status: number;

  constructor(status: number) {
    super('HTTP error: ' + status);
    this.name = 'HttpStatusError';
    this.status = status;
  }
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === 'TimeoutError') {
    return true;
  }
  return /timeout|timed out/i.test(error.message);
}

function isRetryable(error: unknown): boolean {
  if (error instanceof HttpStatusError) {
    return RETRYABLE_STATUS_CODES.has(error.status);
  }
  return isTimeoutError(error);
}

function failureReason(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

function backoffDelayMs(
  failedAttempt: number,
  baseDelayMs: number,
  random: () => number,
): number {
  const exponential = baseDelayMs * 2 ** (failedAttempt - 1);
  const jitter = 0.5 + random() * 0.5;
  return Math.round(exponential * jitter);
}

/**
 * Retries only transient failures so a short outage can recover, while
 * permanent client errors still surface on the first attempt.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const log = options.log ?? ((message: string) => console.warn(message));

  if (maxAttempts < 1) {
    throw new Error('maxAttempts must be at least 1');
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const reason = failureReason(error);
      const retryable = isRetryable(error);

      if (!retryable || attempt === maxAttempts) {
        log(
          retryable
            ? 'Request failed after ' + attempt + ' attempts: ' + reason
            : 'Request failed without retry: ' + reason,
        );
        throw error;
      }

      const delayMs = backoffDelayMs(attempt, baseDelayMs, random);
      log(
        'Retrying attempt ' +
          (attempt + 1) +
          ' of ' +
          maxAttempts +
          ' after ' +
          delayMs +
          'ms: ' +
          reason,
      );
      await sleep(delayMs);
    }
  }

  throw lastError;
}

/**
 * Loads JSON from an API and retries transient timeouts and overload
 * responses so one blip does not fail the caller.
 */
export async function fetchJson(
  url: string,
  options: RetryOptions = {},
): Promise<Record<string, unknown>> {
  return withRetry(async () => {
    const response = await fetch(url);

    if (!response.ok) {
      throw new HttpStatusError(response.status);
    }

    return response.json() as Promise<Record<string, unknown>>;
  }, options);
}
