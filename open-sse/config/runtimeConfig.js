// HTTP status codes
export const HTTP_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  PAYMENT_REQUIRED: 402,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  NOT_ACCEPTABLE: 406,
  REQUEST_TIMEOUT: 408,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504
};

// Re-export error config (backward compat)
export { ERROR_TYPES, DEFAULT_ERROR_MESSAGES, BACKOFF_CONFIG, COOLDOWN_MS } from "./errorConfig.js";

// Cache TTLs (seconds)
export const CACHE_TTL = {
  userInfo: 300,    // 5 minutes
  modelAlias: 3600  // 1 hour
};

// Memory management config
export const MEMORY_CONFIG = {
  sessionTtlMs: 2 * 60 * 60 * 1000,
  sessionCleanupIntervalMs: 30 * 60 * 1000,
  dnsCacheTtlMs: 5 * 60 * 1000,
  proxyDispatchersMaxSize: 20,
};

// Parse a non-negative integer env override, falling back to a default.
// 0 is valid (disables timeout), negative values fallback to default.
function envMs(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  const n = parseInt(raw, 10);
  // -1 = unlimited retries, 0+ = finite count
  return Number.isFinite(n) && (n >= 0 || n === -1) ? n : def;
}

function envUrl(name, def) {
  const raw = process.env[name]?.trim();
  return raw || def;
}
export const SEARXNG_URL = envUrl("SEARXNG_URL", "http://127.0.0.1:8888/search");

// Inter-chunk stall timeout (once tokens are flowing). Generous headroom so
// slow reasoning models aren't aborted mid-stream. Env: STREAM_STALL_TIMEOUT_MS.
export const STREAM_STALL_TIMEOUT_MS = envMs("STREAM_STALL_TIMEOUT_MS", 360 * 1000);

// Time-to-first-token timeout (prompt prefill). Env: STREAM_FIRST_CHUNK_TIMEOUT_MS.
export const STREAM_FIRST_CHUNK_TIMEOUT_MS = envMs("STREAM_FIRST_CHUNK_TIMEOUT_MS", 200 * 1000);

// Fetch connect timeout: abort if upstream doesn't return response headers within this duration
export const FETCH_CONNECT_TIMEOUT_MS = envMs("FETCH_CONNECT_TIMEOUT_MS", 60 * 1000);

// Gemini native TTS fetch timeout: abort if Google does not return response headers in time.
export const GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS = envMs("GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS", 45 * 1000);

// Combo per-target timeout: abort a combo member that does not return response
// headers within this duration and fall back to the next member.
// For streaming this bounds time-to-first-headers only, not token generation.
// Env: COMBO_TARGET_TIMEOUT_MS.
export const DEFAULT_COMBO_TARGET_TIMEOUT_MS = envMs("COMBO_TARGET_TIMEOUT_MS", 30 * 1000);

// Default token limits
export const DEFAULT_MAX_TOKENS = 64000;
export const DEFAULT_MIN_TOKENS = 32000;

export const TOKEN_SAVER_HEADER = "x-9router-token-saver";

// Retry config for 429 responses (legacy - kept for backward compatibility)
export const RETRY_CONFIG = {
  maxAttempts: 2,
  delayMs: 2000
};

// Default retry config by status code: { attempts, delayMs }
// Backward compat: if value is a number, treated as attempts with RETRY_CONFIG.delayMs
// Env overrides: NETWORK_RETRY_502_ATTEMPTS, NETWORK_RETRY_502_DELAY_MS, etc.
export const DEFAULT_RETRY_CONFIG = {
  429: { attempts: 0, delayMs: 0 },
  502: { 
    attempts: envMs("NETWORK_RETRY_502_ATTEMPTS", 3), 
    delayMs: envMs("NETWORK_RETRY_502_DELAY_MS", 3000) 
  },
  503: { 
    attempts: envMs("NETWORK_RETRY_503_ATTEMPTS", 3), 
    delayMs: envMs("NETWORK_RETRY_503_DELAY_MS", 2000) 
  },
  504: { 
    attempts: envMs("NETWORK_RETRY_504_ATTEMPTS", 2), 
    delayMs: envMs("NETWORK_RETRY_504_DELAY_MS", 3000) 
  }
};

// Normalize a retry entry to { attempts, delayMs }
export function resolveRetryEntry(entry) {
  if (entry == null) return { attempts: 0, delayMs: RETRY_CONFIG.delayMs };
  if (typeof entry === "number") return { attempts: entry, delayMs: RETRY_CONFIG.delayMs };
  return {
    attempts: entry.attempts || 0,
    delayMs: entry.delayMs != null ? entry.delayMs : RETRY_CONFIG.delayMs
  };
}

/**
 * Cap retry attempts based on how many accounts the user has configured for a provider.
 * More accounts → fail faster and fall back to the next account instead of burning time
 * retrying the same stalled account.
 *   - >= 5 accounts: max 1 retry attempt per account
 *   - >= 3 accounts: max 2 retry attempts per account
 *   - <  3 accounts: keep configured attempts (no cap)
 */
export function capRetryAttemptsByAccountCount(retryConfig, accountCount) {
  if (!accountCount || accountCount < 3) return retryConfig;
  const maxAttempts = accountCount >= 5 ? 1 : 2;
  const capped = {};
  for (const [status, entry] of Object.entries(retryConfig)) {
    if (entry == null) {
      capped[status] = entry;
    } else if (typeof entry === "number") {
      capped[status] = Math.min(entry, maxAttempts);
    } else {
      capped[status] = { ...entry, attempts: Math.min(entry.attempts ?? 0, maxAttempts) };
    }
  }
  return capped;
}

// Requests containing these texts will bypass provider
export const SKIP_PATTERNS = [
  "Please write a 5-10 word title for the following conversation:"
];

// Stream retry config: retry mid-stream errors (e.g. DeepSeek termination)
// Env: STREAM_RETRY_ATTEMPTS (default: 0 = disabled)
export const STREAM_RETRY_ATTEMPTS = envMs("STREAM_RETRY_ATTEMPTS", 0);
export const STREAM_RETRY_DELAY_MS = envMs("STREAM_RETRY_DELAY_MS", 2000);

/** Check if retry attempts config represents unlimited (-1). */
export function isUnlimitedRetries(attempts) {
  return attempts === -1;
}

/** Check if retry should happen: true when attempts is -1 (unlimited) or > 0. */
export function shouldRetry(attempts) {
  return attempts === -1 || attempts > 0;
}
