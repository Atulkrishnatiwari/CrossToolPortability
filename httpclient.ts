export async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error('HTTP error: ' + response.status);
  }

  return response.json() as Promise<Record<string, unknown>>;
}
