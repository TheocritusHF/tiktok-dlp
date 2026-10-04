export const JSON_REQUEST_TIMEOUT_MS = 15_000;

/**
 * @template T
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {{ fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<T>}
 */
export async function fetchJson(url, init = {}, { fetchImpl = globalThis.fetch } = {}) {
  const callerSignal = init.signal;
  const controller = new AbortController();
  let timer;
  let onAbort;
  const canceled = new Promise((_, reject) => {
    onAbort = () => {
      reject(new DOMException("Request canceled", "AbortError"));
      controller.abort();
    };
    if (callerSignal?.aborted) {
      onAbort();
      return;
    }
    callerSignal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      const error = new Error("Request timed out. Please retry.");
      error.name = "TimeoutError";
      reject(error);
      controller.abort();
    }, JSON_REQUEST_TIMEOUT_MS);
  });
  try {
    // Keep the deadline active through JSON parsing, not only response headers.
    const request = controller.signal.aborted ? canceled : (async () => {
      const response = await fetchImpl(url, { ...init, signal: controller.signal });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const error = new Error(payload?.error || `Archive request failed (${response.status})`);
        error.status = response.status;
        throw error;
      }
      return response.json();
    })();
    return await Promise.race([request, canceled]);
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onAbort);
  }
}
