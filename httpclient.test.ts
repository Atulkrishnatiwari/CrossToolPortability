import {
  computeBackoffDelay,
  fetchJson,
  HttpError,
  isTransientError,
  RetryLogger,
  withRetry,
} from './httpclient';

function mockResponse(status: number, body: Record<string, unknown> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function timeoutError(): Error {
  const error = new Error('The operation was aborted due to timeout');
  error.name = 'TimeoutError';
  return error;
}

function createTestDeps(): {
  logger: RetryLogger & { warn: jest.Mock; error: jest.Mock };
  sleep: jest.Mock<Promise<void>, [number]>;
  random: () => number;
} {
  return {
    logger: { warn: jest.fn(), error: jest.fn() },
    sleep: jest.fn<Promise<void>, [number]>().mockResolvedValue(undefined),
    random: () => 0.5,
  };
}

describe('fetchJson', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns JSON when the request succeeds', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    } as Response);

    const result = await fetchJson('https://example.com/data');

    expect(result).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('throws when the server returns an error', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as Response);

    await expect(
      fetchJson('https://example.com/data')
    ).rejects.toThrow('HTTP error: 500');

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('succeeds on the first attempt without retrying or sleeping', async () => {
    const deps = createTestDeps();
    jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse(200, { id: 1 }));

    const result = await fetchJson('https://example.com/data', deps);

    expect(result).toEqual({ id: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(deps.sleep).not.toHaveBeenCalled();
    expect(deps.logger.warn).not.toHaveBeenCalled();
    expect(deps.logger.error).not.toHaveBeenCalled();
  });

  it.each([429, 502, 503, 504])('retries HTTP %i and succeeds on a later attempt', async (status) => {
    const deps = createTestDeps();
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(mockResponse(status))
      .mockResolvedValueOnce(mockResponse(200, { recovered: true }));

    const result = await fetchJson('https://example.com/data', deps);

    expect(result).toEqual({ recovered: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(deps.sleep).toHaveBeenCalledTimes(1);
    expect(deps.logger.warn).toHaveBeenCalledTimes(1);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      `Attempt 1/3 failed (HTTP error: ${status}); retrying in 250 ms`,
    );
    expect(deps.logger.error).not.toHaveBeenCalled();
  });

  it('retries a network timeout and succeeds on a later attempt', async () => {
    const deps = createTestDeps();
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValueOnce(timeoutError())
      .mockResolvedValueOnce(mockResponse(200, { ok: true }));

    const result = await fetchJson('https://example.com/data', deps);

    expect(result).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      'Attempt 1/3 failed (The operation was aborted due to timeout); retrying in 250 ms',
    );
  });

  it('gives up after the default 3 attempts and rethrows the last error', async () => {
    const deps = createTestDeps();
    jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse(503));

    await expect(fetchJson('https://example.com/data', deps)).rejects.toThrow('HTTP error: 503');

    expect(fetch).toHaveBeenCalledTimes(3);
    // Backoff ceilings are 500 then 1000 ms; random() = 0.5 gives 250 then 500 ms.
    expect(deps.sleep.mock.calls).toEqual([[250], [500]]);
    expect(deps.logger.warn).toHaveBeenNthCalledWith(
      1,
      'Attempt 1/3 failed (HTTP error: 503); retrying in 250 ms',
    );
    expect(deps.logger.warn).toHaveBeenNthCalledWith(
      2,
      'Attempt 2/3 failed (HTTP error: 503); retrying in 500 ms',
    );
    expect(deps.logger.error).toHaveBeenCalledWith(
      'All 3 attempts failed; giving up. Last error: HTTP error: 503',
    );
  });

  it('honours a custom maxAttempts', async () => {
    const deps = createTestDeps();
    jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse(429));

    await expect(
      fetchJson('https://example.com/data', { ...deps, maxAttempts: 5 }),
    ).rejects.toThrow('HTTP error: 429');

    expect(fetch).toHaveBeenCalledTimes(5);
    expect(deps.sleep).toHaveBeenCalledTimes(4);
  });

  it.each([400, 401, 403, 404, 422])('fails immediately without retrying on HTTP %i', async (status) => {
    const deps = createTestDeps();
    jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse(status));

    await expect(fetchJson('https://example.com/data', deps)).rejects.toThrow(
      `HTTP error: ${status}`,
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(deps.sleep).not.toHaveBeenCalled();
    expect(deps.logger.warn).not.toHaveBeenCalled();
    expect(deps.logger.error).toHaveBeenCalledWith(
      `Attempt 1/3 failed with non-retryable error: HTTP error: ${status}`,
    );
  });

  it('passes a timeout signal to fetch on every attempt', async () => {
    const deps = createTestDeps();
    jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse(200));

    await fetchJson('https://example.com/data', { ...deps, timeoutMs: 1234 });

    expect(fetch).toHaveBeenCalledWith(
      'https://example.com/data',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

describe('withRetry', () => {
  it('passes the 1-based attempt number to the operation', async () => {
    const deps = createTestDeps();
    const operation = jest
      .fn<Promise<string>, [number]>()
      .mockRejectedValueOnce(new HttpError(502))
      .mockResolvedValueOnce('done');

    await expect(withRetry(operation, deps)).resolves.toBe('done');

    expect(operation.mock.calls).toEqual([[1], [2]]);
  });

  it('does not retry unknown errors by default', async () => {
    const deps = createTestDeps();
    const operation = jest.fn<Promise<string>, [number]>().mockRejectedValue(new Error('boom'));

    await expect(withRetry(operation, deps)).rejects.toThrow('boom');

    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('uses a custom shouldRetry predicate when provided', async () => {
    const deps = createTestDeps();
    const operation = jest
      .fn<Promise<string>, [number]>()
      .mockRejectedValueOnce(new Error('flaky'))
      .mockResolvedValueOnce('ok');

    await expect(withRetry(operation, { ...deps, shouldRetry: () => true })).resolves.toBe('ok');

    expect(operation).toHaveBeenCalledTimes(2);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects invalid maxAttempts %p', async (maxAttempts) => {
    const operation = jest.fn<Promise<string>, [number]>();

    await expect(withRetry(operation, { maxAttempts })).rejects.toThrow(RangeError);

    expect(operation).not.toHaveBeenCalled();
  });
});

describe('computeBackoffDelay', () => {
  it('grows exponentially from the base delay', () => {
    const almostOne = (): number => 0.999999;

    expect(computeBackoffDelay(1, 500, 10_000, almostOne)).toBe(499);
    expect(computeBackoffDelay(2, 500, 10_000, almostOne)).toBe(999);
    expect(computeBackoffDelay(3, 500, 10_000, almostOne)).toBe(1999);
  });

  it('caps the delay at maxDelayMs', () => {
    expect(computeBackoffDelay(10, 500, 3000, () => 0.999999)).toBe(2999);
  });

  it('applies jitter across the full range', () => {
    expect(computeBackoffDelay(3, 500, 10_000, () => 0)).toBe(0);
    expect(computeBackoffDelay(3, 500, 10_000, () => 0.25)).toBe(500);
  });
});

describe('isTransientError', () => {
  it.each([429, 502, 503, 504])('treats HTTP %i as transient', (status) => {
    expect(isTransientError(new HttpError(status))).toBe(true);
  });

  it.each([400, 401, 403, 404, 500])('treats HTTP %i as non-transient', (status) => {
    expect(isTransientError(new HttpError(status))).toBe(false);
  });

  it('treats a TimeoutError as transient', () => {
    expect(isTransientError(timeoutError())).toBe(true);
  });

  it('treats an undici connect timeout as transient', () => {
    const error = new TypeError('fetch failed', {
      cause: Object.assign(new Error('Connect Timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
    });

    expect(isTransientError(error)).toBe(true);
  });

  it('treats other network errors as non-transient', () => {
    const error = new TypeError('fetch failed', {
      cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
    });

    expect(isTransientError(error)).toBe(false);
  });
});
