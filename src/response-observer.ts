import { AsyncLocalStorage } from "node:async_hooks";

type ResponseObserver = (response: Response, requestUrl: string | undefined) => void;
interface FetchObserverSlot {
  storage: AsyncLocalStorage<ResponseObserver>;
  previous: typeof fetch;
  wrapper: typeof fetch;
}

const FETCH_OBSERVER_SYMBOL = Symbol.for("oira666.pi-limits-wait.attempt-fetch-observer.v1");
type InterceptableGlobal = typeof globalThis & { [FETCH_OBSERVER_SYMBOL]?: FetchObserverSlot };

function requestUrl(input: Parameters<typeof fetch>[0]): string | undefined {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function observerSlot(): FetchObserverSlot | undefined {
  if (typeof globalThis.fetch !== "function") return undefined;
  const target = globalThis as InterceptableGlobal;
  const existing = target[FETCH_OBSERVER_SYMBOL];
  if (existing) {
    // Never stack another limits-wait wrapper if another owner replaced fetch
    // after us. In that case onResponse/provider errors remain the fallback.
    return globalThis.fetch === existing.wrapper ? existing : undefined;
  }

  const slot = {} as FetchObserverSlot;
  slot.storage = new AsyncLocalStorage<ResponseObserver>();
  slot.previous = globalThis.fetch.bind(globalThis);
  slot.wrapper = (async (...args: Parameters<typeof fetch>) => {
    const observer = slot.storage.getStore();
    const url = requestUrl(args[0]);
    const response = await slot.previous(...args);
    observer?.(response, response.url || url);
    return response;
  }) as typeof fetch;
  Object.defineProperty(target, FETCH_OBSERVER_SYMBOL, { configurable: true, value: slot });
  globalThis.fetch = slot.wrapper;
  return slot;
}

/**
 * Observe fetch responses only in the async execution chain of one provider
 * attempt. This is observational only: it never throws or consumes a body.
 * Outside that chain the stable process trampoline is transparent.
 */
export function withAttemptResponseObserver<T>(observer: ResponseObserver, callback: () => T): T {
  const slot = observerSlot();
  return slot ? slot.storage.run(observer, callback) : callback();
}
