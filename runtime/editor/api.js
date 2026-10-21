// Edit-server client. The auth cookie comes from the page load; every /api call also
// carries the per-start token header. Errors arrive as { error: { code, message } }.

class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function createApi(token) {
  async function request(method, path, body) {
    const headers = { 'X-Learndoc-Token': token };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(path, {
        method,
        headers,
        credentials: 'same-origin',
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new ApiError('network', err.message);
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new ApiError(data?.error?.code ?? `http_${res.status}`, data?.error?.message ?? res.statusText);
    }
    return data;
  }

  return {
    get: (path) => request('GET', path),
    post: (path, body = {}) => request('POST', path, body),
    del: (path) => request('DELETE', path),
  };
}
