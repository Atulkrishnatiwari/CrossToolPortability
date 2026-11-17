export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BASE_DELAY_MS = 500;

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  logger?: (message: string) => void;
}

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * Retry transient failures using exponential backoff with jitter to avoid
 * hammering an unreliable upstream service.
 */
export async function retry_with_backoff<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const logger = options.logger ?? console.warn;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('maxAttempts must be an integer greater than 0.');
  }

  let attempt = 1;

  while (true) {
    try {
      return await operation();
    } catch (error: unknown) {
      const retryable = isRetryableError(error);

      if (!retryable || attempt >= maxAttempts) {
        throw error;
      }

      const delayMs = calculateBackoffMs(attempt, baseDelayMs);
      logger(
        `Retry attempt ${attempt + 1}/${maxAttempts} after ${delayMs}ms because ${describeError(error)}.`
      );

      await wait(delayMs);
      attempt += 1;
    }
  }
}

function calculateBackoffMs(attempt: number, baseDelayMs: number): number {
  return baseDelayMs * 2 ** (attempt - 1) + Math.random() * baseDelayMs;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function isRetryableError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    if ('status' in error && typeof error.status === 'number') {
      return isRetryableHttpStatus(error.status);
    }

    if ('cause' in error && error.cause !== undefined && isRetryableError(error.cause)) {
      return true;
    }
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (
      message.includes('timeout') ||
      message.includes('timed out') ||
      message.includes('network') ||
      message.includes('failed to fetch') ||
      message.includes('fetch failed')
    ) {
      return true;
    }
  }

  return false;
}

function describeError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    return `HTTP ${String(error.status)}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function fetchJsonOnce(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new HttpError(response.status, 'HTTP error: ' + response.status);
  }

  return response.json() as Promise<Record<string, unknown>>;
}

/**
 * Fetch JSON from a URL, retrying transient failures without masking permanent
 * client-side errors.
 */
export async function fetchJson(url: string): Promise<Record<string, unknown>> {
  return retry_with_backoff(() => fetchJsonOnce(url));
}
