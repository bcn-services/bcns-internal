/**
 * next-cache-harness.mjs — run Next's REAL `unstable_cache` under plain node.
 *
 * Why this exists. lib/inbox-badge.ts reads the unread count through the
 * SERVICE client, which bypasses RLS. The one thing keeping one person's badge
 * out of another's sidebar is therefore the cache KEY, and a key collision is
 * invisible to a source-text assertion. To see the key, Next's own code has to
 * run — a hand-rolled imitation of unstable_cache would only prove the
 * imitation.
 *
 * Two things are missing outside a Next server, and both are supplied here:
 *
 *   1. `globalThis.AsyncLocalStorage`. next/dist/server/app-render/
 *      async-local-storage throws "AsyncLocalStorage accessed in runtime where
 *      it is not available" without it. node:async_hooks is the same class Next
 *      picks up in its node runtime.
 *
 *   2. `globalThis.__incrementalCache`. unstable_cache falls back to it when
 *      there is no static-generation store, which is exactly the "called
 *      outside a render" branch. Its `fetchCacheKey` is handed the invocation
 *      key verbatim, which is what makes the key observable.
 *
 * IMPORT THIS FIRST. It must be evaluated before anything that pulls in
 * next/cache, so the global is set before the module that reads it loads.
 */
import { AsyncLocalStorage } from "node:async_hooks";

globalThis.AsyncLocalStorage ??= AsyncLocalStorage;

/**
 * A minimal in-memory incremental cache with the surface unstable_cache uses.
 * `keysSeen` is every invocation key it was asked to hash, in order.
 */
export function installFakeIncrementalCache() {
  const store = new Map();
  const cache = {
    keysSeen: [],
    store,
    isOnDemandRevalidate: false,
    async fetchCacheKey(invocationKey) {
      cache.keysSeen.push(invocationKey);
      return invocationKey;
    },
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value) {
      store.set(key, { value, isStale: false });
    },
  };
  globalThis.__incrementalCache = cache;
  return cache;
}

export function uninstallFakeIncrementalCache() {
  globalThis.__incrementalCache = undefined;
}
