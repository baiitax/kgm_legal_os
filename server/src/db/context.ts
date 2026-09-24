import { AsyncLocalStorage } from 'node:async_hooks';
import type { Queryable, RequestContext, Scope } from './types.js';

/**
 * Request-scoped query context.
 *
 * `Db.acquire()` hands out a Scope bound to one HTTP request; the middleware
 * stores it here. Repository methods pick it up automatically, which means a
 * query executed while handling a client request is ALWAYS scoped to that
 * principal's tenant and client set — there is no way for a handler to reach
 * for an unscoped connection by accident.
 *
 * The scope also provides `tx()`, so a mutation and its audit event commit or
 * roll back together (§38: a sensitive operation cannot succeed without its
 * audit record).
 *
 * Outside a context (background jobs, seeding, tests) it falls back to the
 * supplied default Queryable.
 */
interface Store {
  scope: Scope;
  ctx: RequestContext;
}

const storage = new AsyncLocalStorage<Store>();

export function runInContext<T>(scope: Scope, ctx: RequestContext, fn: () => T): T {
  return storage.run({ scope, ctx }, fn);
}

export function currentScope(): Scope | null {
  return storage.getStore()?.scope ?? null;
}

export function currentQueryable(fallback: Queryable): Queryable {
  return storage.getStore()?.scope.q ?? fallback;
}

export function currentContext(): RequestContext | null {
  return storage.getStore()?.ctx ?? null;
}

export function setContextInStore(ctx: RequestContext): void {
  const store = storage.getStore();
  if (store) store.ctx = ctx;
}
