/** HTTP status codes that indicate a temporary server-side or rate-limit condition. */
const RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([429, 502, 503, 504]);

/** Error codes Node's fetch (undici) attaches to `error.cause` when a connection times out. */
const TIMEOUT_ERROR_CODES: ReadonlySet<string> = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/** Minimal logging surface so callers can route retry logs wherever they want. */
export interface RetryLogger {
  warn(message: string): void;
  error(message: string): void;
}

export interface RetryOptions {
  /** Total number of attempts, including the first one. Must be an integer >= 1. Default: 3. */
  maxAttempts?: number;
  /** Base delay for exponential backoff, in milliseconds. Default: 500. */
  baseDelayMs?: number;
  /** Upper bound for a single backoff delay, in milliseconds. Default: 10000. */
  maxDelayMs?: number;
  /** Decides whether an error is worth retrying. Default: `isTransientError`. */
  shouldRetry?: (error: unknown) => boolean;
  /** Injected for tests; defaults to a real timer-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for tests; defaults to `Math.random`. Must return a value in [0, 1). */
  random?: () => number;
  /** Where retry and failure messages go. Default: `console`. */
  logger?: RetryLogger;
}

export interface FetchJsonOptions extends RetryOptions {
  /** Per-attempt request timeout, in milliseconds. Default: 10000. */
  timeoutMs?: number;
}

/**
 * Thrown for non-OK HTTP responses. Carries the status code so retry logic can
 * tell transient server/rate-limit errors apart from permanent client errors.
 */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super('HTTP error: ' + status);
    this.name = 'HttpError';
    this.status = status;
  }
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 10_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === 'TimeoutError') {
    return true;
  }
  const cause: unknown = (error as { cause?: unknown }).cause;
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    const code: unknown = (cause as { code: unknown }).code;
    return typeof code === 'string' && TIMEOUT_ERROR_CODES.has(code);
  }
  return false;
}

/**
 * Classifies an error as transient. Only network timeouts and HTTP 429/502/503/504
 * are retried: other 4xx responses mean the request itself is wrong, and
 * retrying it would only add load without changing the outcome.
 */
export function isTransientError(error: unknown): boolean {
  if (error instanceof HttpError) {
    return RETRYABLE_STATUS_CODES.has(error.status);
  }
  return isTimeoutError(error);
}

/**
 * Computes a "full jitter" exponential backoff delay: a random value in
 * [0, min(maxDelayMs, baseDelayMs * 2^(attempt - 1))). The randomness spreads
 * out retries from many clients so they don't hit a recovering server in lockstep.
 */
export function computeBackoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number,
): number {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs `operation` and retries it on transient failures with jittered
 * exponential backoff. This keeps resilience logic in one reusable place, so
 * callers don't each build their own retry loop. Every retry and the final
 * failure are logged, so the caller never fails or recovers silently.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const shouldRetry = options.shouldRetry ?? isTransientError;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const logger = options.logger ?? console;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError('maxAttempts must be an integer >= 1, got ' + maxAttempts);
  }

  for (let attempt = 1; ; attempt++) {
    try {
      return await operation(attempt);
    } catch (error: unknown) {
      const reason = describeError(error);

      if (!shouldRetry(error)) {
        logger.error(`Attempt ${attempt}/${maxAttempts} failed with non-retryable error: ${reason}`);
        throw error;
      }

      if (attempt >= maxAttempts) {
        logger.error(`All ${maxAttempts} attempts failed; giving up. Last error: ${reason}`);
        throw error;
      }

      const delayMs = computeBackoffDelay(attempt, baseDelayMs, maxDelayMs, random);
      logger.warn(
        `Attempt ${attempt}/${maxAttempts} failed (${reason}); retrying in ${delayMs} ms`,
      );
      await sleep(delayMs);
    }
  }
}

/**
 * Fetches a URL and parses the response body as JSON. Each attempt has its own
 * timeout, and network timeouts plus HTTP 429/502/503/504 are retried with
 * jittered exponential backoff (default: 3 attempts, 500 ms base delay).
 * Other non-OK responses, such as 400/404/500, throw an `HttpError` right away.
 */
export async function fetchJson(
  url: string,
  options: FetchJsonOptions = {},
): Promise<Record<string, unknown>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return withRetry(async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });

    if (!response.ok) {
      throw new HttpError(response.status);
    }

    return response.json() as Promise<Record<string, unknown>>;
  }, options);
}
