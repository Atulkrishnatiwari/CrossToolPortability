import { fetchJson } from './httpclient';

describe('fetchJson', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('succeeds on the first attempt', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    } as Response);

    const result = await fetchJson('https://example.com/data');

    expect(result).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('succeeds after retrying a transient error', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({}),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ retry: true }),
      } as Response);

    const result = await fetchJson('https://example.com/data');

    expect(result).toEqual({ retry: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Retry attempt 2/3 after')
    );
  });

  it('exhausts retries after the configured maximum attempts', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(
      new Error('timeout')
    );

    await expect(fetchJson('https://example.com/data')).rejects.toThrow('timeout');
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('throws when the server returns a retryable HTTP 500 error', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'internal server error' }),
    } as Response);

    await expect(fetchJson('https://example.com/data')).rejects.toThrow(
      'HTTP error: 500'
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('fails immediately for non-retryable errors', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'bad request' }),
    } as Response);

    await expect(fetchJson('https://example.com/data')).rejects.toThrow(
      'HTTP error: 400'
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
