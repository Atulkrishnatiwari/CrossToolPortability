import { fetchJson } from './httpclient';

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
});
