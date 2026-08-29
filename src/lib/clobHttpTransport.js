import https from "node:https";
import { performance } from "node:perf_hooks";
import axios from "axios";

// A dedicated pool for CLOB traffic. It is deliberately scoped to registered
// CLOB origins so unrelated HTTP clients in this process keep their own agents.
const CONNECTION_META = Symbol("clobHttpConnectionMeta");
const TRACE_KEY = "__helpmeClobConnectionTrace";

function boundedNumber(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function enabled(value, fallback = true) {
  if (value == null || value === "") return fallback;
  return !["0", "false", "off", "no"].includes(String(value).trim().toLowerCase());
}

export function resolveClobHttpSettings(env = process.env) {
  const socketTimeoutMs = boundedNumber(env.CLOB_KEEPALIVE_TIMEOUT_MS, 120_000, 10_000, 600_000);
  const configuredIntervalMs = boundedNumber(env.CLOB_PRECONNECT_INTERVAL_MS, 25_000, 5_000, 300_000);
  const configuredWarmTimeoutMs = boundedNumber(env.CLOB_PRECONNECT_REQUEST_TIMEOUT_MS, 2_000, 250, 10_000);
  const cadenceCapMs = Math.floor(socketTimeoutMs / 4);
  return Object.freeze({
    enabled: enabled(env.CLOB_PRECONNECT_ENABLED, true),
    socketTimeoutMs,
    activeSocketTimeoutMs: boundedNumber(env.CLOB_REQUEST_SOCKET_TIMEOUT_MS, 5_000, 1_000, 30_000),
    intervalMs: Math.min(configuredIntervalMs, cadenceCapMs),
    warmTimeoutMs: Math.min(configuredWarmTimeoutMs, cadenceCapMs),
    requestTimeoutMs: Math.min(configuredWarmTimeoutMs, cadenceCapMs),
    prearmRatio: boundedNumber(env.CLOB_PREARM_RATIO, 0.6, 0.1, 0.99),
    maxSockets: Math.floor(boundedNumber(env.CLOB_KEEPALIVE_MAX_SOCKETS, 2, 1, 8)),
  });
}

export const clobHttpSettings = resolveClobHttpSettings();

class ClobHttpsAgent extends https.Agent {
  keepSocketAlive(socket) {
    const keep = super.keepSocketAlive(socket);
    if (keep) socket.setTimeout(clobHttpSettings.socketTimeoutMs);
    return keep;
  }

  reuseSocket(socket, request) {
    super.reuseSocket(socket, request);
    socket.setTimeout(clobHttpSettings.activeSocketTimeoutMs);
  }
}

const clobHttpsAgent = new ClobHttpsAgent({
  keepAlive: true,
  keepAliveMsecs: 1_000,
  timeout: clobHttpSettings.activeSocketTimeoutMs,
  maxSockets: clobHttpSettings.maxSockets,
  maxFreeSockets: clobHttpSettings.maxSockets,
  scheduling: "lifo",
});

const clobOrigins = new Set();
let interceptorsInstalled = false;
let warmPromise = null;
let warmAbortController = null;
let warmOrigin = null;
let activeOrderSubmissions = 0;
const lastWarmStartedByOrigin = new Map();
const reserveRefreshedByOrigin = new Map();
const warmerTimers = new Map();
const counters = {
  requests: 0,
  reused: 0,
  cold: 0,
  unknown: 0,
  warmAttempts: 0,
  warmRequests: 0,
  warmFailures: 0,
  warmSkippedForOrder: 0,
  warmAbortedForOrder: 0,
  poolPrimeAttempts: 0,
};

function originOf(value) {
  try { return new URL(String(value)).origin; } catch { return null; }
}

function nativeRequestOf(response) {
  let request = response?.request || null;
  for (let i = 0; i < 3 && request; i++) {
    if (typeof request.reusedSocket === "boolean") return request;
    request = request._currentRequest || request._redirectable?._currentRequest || null;
  }
  return response?.request || null;
}

function attachConnectionMeta(response) {
  const trace = response?.config?.[TRACE_KEY];
  if (!trace) return response;
  const request = nativeRequestOf(response);
  const reusedSocket = typeof request?.reusedSocket === "boolean" ? request.reusedSocket : null;
  const meta = Object.freeze({
    reusedSocket,
    requestMs: Math.max(0, performance.now() - trace.startedMonoMs),
    method: trace.method,
    path: trace.path,
  });
  counters.requests++;
  if (reusedSocket === true) counters.reused++;
  else if (reusedSocket === false) counters.cold++;
  else counters.unknown++;
  try { Object.defineProperty(response, CONNECTION_META, { value: meta, enumerable: false, configurable: true }); } catch {}
  if (response?.data && typeof response.data === "object") {
    try { Object.defineProperty(response.data, CONNECTION_META, { value: meta, enumerable: true, configurable: true }); } catch {}
  }
  return response;
}

function installInterceptors() {
  if (interceptorsInstalled) return;
  interceptorsInstalled = true;
  axios.interceptors.request.use((request) => {
    const origin = originOf(request.url);
    if (!origin || !clobOrigins.has(origin)) return request;
    const url = new URL(String(request.url));
    request.httpsAgent = clobHttpsAgent;
    const callerTimeoutMs = Number(request.timeout);
    request.timeout = Number.isFinite(callerTimeoutMs) && callerTimeoutMs > 0
      ? Math.min(callerTimeoutMs, clobHttpSettings.activeSocketTimeoutMs)
      : clobHttpSettings.activeSocketTimeoutMs;
    request[TRACE_KEY] = {
      startedMonoMs: performance.now(),
      method: String(request.method || "get").toUpperCase(),
      path: url.pathname,
    };
    return request;
  });
  axios.interceptors.response.use(
    (response) => attachConnectionMeta(response),
    (error) => {
      if (error?.response) attachConnectionMeta(error.response);
      return Promise.reject(error);
    },
  );
}

export function installClobHttpTransport(host) {
  const origin = originOf(host);
  if (!origin || !origin.startsWith("https://")) throw new Error(`CLOB host must be HTTPS (got ${host})`);
  clobOrigins.add(origin);
  installInterceptors();
  return clobHttpSettings;
}

export function clobConnectionMeta(responseData) {
  return responseData?.[CONNECTION_META] || null;
}

export function clobConnectionStats() {
  return Object.freeze({ ...counters, activeOrderSubmissions });
}

// Orders take priority over the background /ok warmer. If the two collide,
// signing runs while the aborted warmer drains, then POST waits on warmDrain.
export function beginClobOrderSubmission() {
  activeOrderSubmissions++;
  const warmDrain = warmPromise ? warmPromise.catch(() => null) : null;
  if (warmAbortController && !warmAbortController.signal.aborted) {
    counters.warmAbortedForOrder++;
    warmAbortController.abort(new Error("CLOB order submission has transport priority"));
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeOrderSubmissions = Math.max(0, activeOrderSubmissions - 1);
  };
  Object.defineProperty(release, "warmDrain", { value: warmDrain, enumerable: false });
  return release;
}

export function clobOrderSubmissionActive() {
  return activeOrderSubmissions > 0;
}

export function warmClobConnection({ host, reason = "periodic", force = false, minIntervalMs = clobHttpSettings.intervalMs } = {}) {
  if (!clobHttpSettings.enabled) return Promise.resolve({ ok: false, skipped: "disabled" });
  const origin = originOf(host);
  if (!origin) return Promise.resolve({ ok: false, skipped: "invalid-host" });
  installClobHttpTransport(origin);
  if (activeOrderSubmissions > 0) {
    counters.warmSkippedForOrder++;
    return Promise.resolve({ ok: false, skipped: "order-priority" });
  }
  if (warmPromise) {
    if (warmOrigin === origin) return warmPromise;
    const activeWarm = warmPromise;
    return activeWarm.catch(() => null).then(() => warmClobConnection({ host: origin, reason, force, minIntervalMs }));
  }

  const now = performance.now();
  const lastStarted = lastWarmStartedByOrigin.get(origin);
  if (!force && Number.isFinite(lastStarted) && now >= lastStarted
      && now - lastStarted < Math.max(0, Number(minIntervalMs) || 0)) {
    return Promise.resolve({ ok: false, skipped: "throttled" });
  }
  lastWarmStartedByOrigin.set(origin, now);
  counters.warmAttempts++;

  const reserveSize = Math.min(2, clobHttpSettings.maxSockets);
  const lastReserve = reserveRefreshedByOrigin.get(origin);
  const refreshAfterMs = Math.max(0, Math.min(
    clobHttpSettings.socketTimeoutMs / 2,
    clobHttpSettings.socketTimeoutMs * 0.9 - clobHttpSettings.warmTimeoutMs - clobHttpSettings.intervalMs,
  ));
  const refreshReserve = force || !Number.isFinite(lastReserve) || now - lastReserve >= refreshAfterMs;
  const requestCount = refreshReserve ? reserveSize : 1;
  if (requestCount > 1) counters.poolPrimeAttempts++;
  const controller = new AbortController();
  warmAbortController = controller;
  warmOrigin = origin;
  counters.warmRequests += requestCount;

  const requestOne = () => axios.get(`${origin}/ok`, {
    httpsAgent: clobHttpsAgent,
    signal: controller.signal,
    timeout: clobHttpSettings.requestTimeoutMs,
    validateStatus: (status) => status >= 200 && status < 400,
  }).then((response) => ({ ok: true, connection: clobConnectionMeta(response.data) || clobConnectionMeta(response) }))
    .catch((error) => ({ ok: false, aborted: controller.signal.aborted, error: error?.message || String(error) }));

  warmPromise = Promise.all(Array.from({ length: requestCount }, requestOne)).then((results) => {
    const successful = results.filter((result) => result.ok);
    const failed = results.filter((result) => !result.ok && !result.aborted);
    counters.warmFailures += failed.length;
    if (successful.length === requestCount && requestCount === reserveSize) reserveRefreshedByOrigin.set(origin, now);
    else if (successful.length !== requestCount) reserveRefreshedByOrigin.delete(origin);
    return {
      ok: successful.length > 0,
      reason,
      elapsedMs: Math.max(0, performance.now() - now),
      connection: successful[0]?.connection || null,
      connections: successful.map((result) => result.connection).filter(Boolean),
      requestCount,
      aborted: results.some((result) => result.aborted),
      error: successful.length ? undefined : failed[0]?.error,
    };
  }).finally(() => {
    if (warmAbortController === controller) warmAbortController = null;
    if (warmOrigin === origin) warmOrigin = null;
    warmPromise = null;
  });
  return warmPromise;
}

export function startClobConnectionWarmer(host, onResult) {
  const origin = originOf(host);
  if (!origin || !clobHttpSettings.enabled) return () => {};
  installClobHttpTransport(origin);
  if (!warmerTimers.has(origin)) {
    void warmClobConnection({ host: origin, reason: "startup", force: true }).then(onResult).catch(() => {});
    const timer = setInterval(() => {
      void warmClobConnection({ host: origin, reason: "periodic" }).then(onResult).catch(() => {});
    }, clobHttpSettings.intervalMs);
    timer.unref?.();
    warmerTimers.set(origin, timer);
  }
  return () => {
    const timer = warmerTimers.get(origin);
    if (timer) clearInterval(timer);
    warmerTimers.delete(origin);
  };
}
