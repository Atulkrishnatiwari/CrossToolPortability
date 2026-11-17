import { fetchJson, retryWithBackoff } from './httpclient';

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

    await expect(fetchJson('https://example.com/data')).rejects.toThrow('HTTP error: 500');

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns JSON on the first attempt', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    } as Response);

    await expect(fetchJson('https://example.com/data')).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('succeeds after retrying a transient error', async () => {
    const fetchMock = jest.spyOn(global, 'fetch');
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 503 } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      } as Response);
    const logger = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Math, 'random').mockReturnValue(0);

    await expect(fetchJson('https://example.com/data')).resolves.toEqual({ ok: true });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(logger).toHaveBeenCalledWith('Retrying attempt 2/3 in 0ms: HTTP error: 503');
  });

  it('throws after the configured maximum attempts', async () => {
    const operation = jest.fn().mockRejectedValue(new Error('request timeout'));
    const logger = jest.fn();

    await expect(
      retryWithBackoff(operation, { maxAttempts: 3, baseDelayMs: 0, logger })
    ).rejects.toThrow('request timeout');

    expect(operation).toHaveBeenCalledTimes(3);
    expect(logger).toHaveBeenCalledTimes(3);
    expect(logger).toHaveBeenLastCalledWith(
      'Request failed on attempt 3/3 (attempts exhausted): request timeout'
    );
  });

  it('fails immediately for a non-retryable error', async () => {
    const operation = jest.fn().mockRejectedValue(
      Object.assign(new Error('HTTP error: 400'), { status: 400 })
    );
    const logger = jest.fn();

    await expect(
      retryWithBackoff(operation, { maxAttempts: 3, baseDelayMs: 0, logger })
    ).rejects.toThrow('HTTP error: 400');

    expect(operation).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith(
      'Request failed on attempt 1/3 (non-retryable): HTTP error: 400'
    );
  });
});
