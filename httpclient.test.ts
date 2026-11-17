import { fetchJson } from './httpclient';

function jsonResponse(status: number, body: Record<string, unknown> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('fetchJson', () => {
  let sleep: jest.Mock;

  beforeEach(() => {
    sleep = jest.fn(async () => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns JSON when the request succeeds', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(200, { ok: true }));

    const result = await fetchJson('https://example.com/data');

    expect(result).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns JSON after retrying a transient error', async () => {
    const log = jest.fn();
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse(503))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const result = await fetchJson('https://example.com/data', {
      sleep,
      random: () => 0,
      log,
    });

    expect(result).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(250);
    expect(log).toHaveBeenCalledWith(
      'Retrying attempt 2 of 3 after 250ms: HTTP error: 503',
    );
  });

  it('retries a network timeout and then succeeds', async () => {
    const log = jest.fn();
    const timeout = new Error('network timeout');
    timeout.name = 'TimeoutError';
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const result = await fetchJson('https://example.com/data', {
      sleep,
      random: () => 1,
      log,
    });

    expect(result).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(
      'Retrying attempt 2 of 3 after 500ms: network timeout',
    );
  });

  it('throws after the configured maximum attempts', async () => {
    const log = jest.fn();
    jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(504));

    await expect(
      fetchJson('https://example.com/data', {
        maxAttempts: 3,
        sleep,
        random: () => 0,
        log,
      }),
    ).rejects.toThrow('HTTP error: 504');

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(
      'Retrying attempt 2 of 3 after 250ms: HTTP error: 504',
    );
    expect(log).toHaveBeenCalledWith(
      'Retrying attempt 3 of 3 after 500ms: HTTP error: 504',
    );
    expect(log).toHaveBeenCalledWith(
      'Request failed after 3 attempts: HTTP error: 504',
    );
  });

  it('fails immediately on a non-retryable client error', async () => {
    const log = jest.fn();
    jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(404));

    await expect(
      fetchJson('https://example.com/data', { sleep, log }),
    ).rejects.toThrow('HTTP error: 404');

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      'Request failed without retry: HTTP error: 404',
    );
  });

  it('throws when the server returns an error', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(500));

    await expect(
      fetchJson('https://example.com/data', { sleep, log: jest.fn() }),
    ).rejects.toThrow('HTTP error: 500');

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
