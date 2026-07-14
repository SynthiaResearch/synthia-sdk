/**
 * Minimal authed client for the /v1/account/* dashboard routes (baseline
 * lookup, run detail). Deliberately separate from the SDK's private Http:
 * these routes don't carry session headers and this stays a ~30-line
 * surface instead of widening the SDK's API.
 */
export class AccountApi {
  #baseUrl: string;
  #apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.#baseUrl = baseUrl.replace(/\/$/, "");
    this.#apiKey = apiKey;
  }

  async get(
    path: string,
    params: Record<string, string | number> = {},
  ): Promise<{ status: number; body: any }> {
    const url = new URL(this.#baseUrl + path);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
    const r = await fetch(url, {
      headers: { authorization: `Bearer ${this.#apiKey}` },
    });
    let body: any = null;
    try {
      body = await r.json();
    } catch {
      /* non-JSON error body; status is enough */
    }
    return { status: r.status, body };
  }
}
