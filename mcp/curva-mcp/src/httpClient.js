// Thin HTTP client for the Curva Companion backend. undici gives us keep-alive
// and predictable timeouts without the noise of a full fetch wrapper.
//
// The Companion returns { success, error, data } for every JSON endpoint (see
// backend/CLAUDE.md "Standard Response Format"). We normalize on that shape so
// callers can trust the return.

import { request } from 'undici';
import { CONFIG } from './config.js';
import { logJson } from './safety.js';

const DEFAULT_TIMEOUT_MS = 15_000;

// Build the URL joining base + path, guarding against accidental double slash.
function joinUrl(base, path) {
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

// Core HTTP call. Never throws for HTTP status codes — the caller decides how
// to interpret non-2xx bodies. Throws only for transport failures / timeouts.
export async function backendRequest(path, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    query,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = opts;

  let url = joinUrl(CONFIG.backendBaseUrl, path);
  if (query && typeof query === 'object') {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += (url.includes('?') ? '&' : '?') + s;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await request(url, {
      method,
      headers: {
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    logJson('error', 'backend.transport_error', {
      path,
      method,
      message: err?.message?.slice(0, 200),
    });
    throw new Error(`BACKEND_UNREACHABLE: ${err?.message || 'unknown'}`);
  } finally {
    clearTimeout(timer);
  }

  const status = res.statusCode;
  const responseHeaders = res.headers;
  const contentType = String(responseHeaders['content-type'] || '');
  let payload;
  try {
    if (contentType.includes('application/json')) {
      payload = await res.body.json();
    } else {
      payload = { raw: await res.body.text() };
    }
  } catch (err) {
    logJson('error', 'backend.parse_error', { path, method, status });
    throw new Error(`BACKEND_MALFORMED_RESPONSE: ${err?.message || 'parse failed'}`);
  }

  return { status, headers: responseHeaders, payload };
}

// Convenience: unwrap { success, data } and throw on failure. Callers that need
// the raw payload (e.g. x402 402 challenge, header inspection) skip this.
export async function backendJson(path, opts = {}) {
  const { status, payload } = await backendRequest(path, opts);
  if (status < 200 || status >= 300) {
    const code = payload?.error?.code || 'BACKEND_ERROR';
    const message = payload?.error?.message || `HTTP ${status}`;
    throw new Error(`${code}: ${message}`);
  }
  if (payload && payload.success === false) {
    const code = payload.error?.code || 'BACKEND_ERROR';
    const message = payload.error?.message || 'request failed';
    throw new Error(`${code}: ${message}`);
  }
  return payload?.data ?? payload;
}
