"""Minimal authed client for the /v1/account/* dashboard routes — port of
cli/http.ts. Separate from the SDK client: these routes don't carry session
headers, and this stays a tiny surface."""

import httpx


class AccountApi:
    def __init__(self, base_url: str, api_key: str):
        self._base = base_url.rstrip("/")
        self._headers = {"Authorization": f"Bearer {api_key}"}

    def get(self, path: str, params: dict | None = None) -> tuple[int, object]:
        try:
            r = httpx.get(self._base + path, params=params or {},
                          headers=self._headers, timeout=60.0)
        except httpx.HTTPError:
            return 0, None
        try:
            return r.status_code, r.json()
        except Exception:
            return r.status_code, None
