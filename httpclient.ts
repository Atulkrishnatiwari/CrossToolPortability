export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  logger?: (message: string) => void;
}

interface StatusError extends Error {
  status: number;
}

function isRetryableError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const status = 'status' in error ? error.status : undefined;
  if (typeof status === 'number') {
    return status === 429 || status === 502 || status === 503 || status === 504;
  }

  const candidate = error as { name?: unknown; message?: unknown; code?: unknown };
  return (
    candidate.name === 'TimeoutError' ||
    candidate.code === 'ETIMEDOUT' ||
    candidate.code === 'ESOCKETTIMEDOUT' ||
    (typeof candidate.message === 'string' && /timeout/i.test(candidate.message))
  );
}

function getErrorReason(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function getDelay(baseDelayMs: number, failedAttempt: number): number {
  const exponentialDelay = baseDelayMs * 2 ** (failedAttempt - 1);
  return Math.floor(Math.random() * (exponentialDelay + 1));
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/** Retries transient operations while avoiding repeated requests for permanent failures. */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const logger = options.logger ?? console.warn;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('maxAttempts must be a positive integer');
  }
  if (baseDelayMs < 0) {
    throw new Error('baseDelayMs must not be negative');
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const retryable = isRetryableError(error);
      if (!retryable) {
        logger(
          `Request failed on attempt ${attempt}/${maxAttempts} (non-retryable): ${getErrorReason(error)}`
        );
        throw error;
      }
      if (attempt === maxAttempts) {
        logger(
          `Request failed on attempt ${attempt}/${maxAttempts} (attempts exhausted): ${getErrorReason(error)}`
        );
        throw error;
      }

      const delayMs = getDelay(baseDelayMs, attempt);
      logger(
        `Retrying attempt ${attempt + 1}/${maxAttempts} in ${delayMs}ms: ${getErrorReason(error)}`
      );
      await wait(delayMs);
    }
  }

  throw new Error('Retry operation did not complete');
}

export async function fetchJson(url: string): Promise<Record<string, unknown>> {
  return retryWithBackoff(async () => {
    const response = await fetch(url);

    if (!response.ok) {
      const error = new Error('HTTP error: ' + response.status) as StatusError;
      error.status = response.status;
      throw error;
    }

    return response.json() as Promise<Record<string, unknown>>;
  });
}
