/**
 * THE CONNECTION, AND THE TWO WAYS IT WAS FAILING IN PRODUCTION.
 *
 * A firm sign-in on the deployed system returned
 *
 *     The request could not be completed
 *     Something unexpected went wrong. Please try again.
 *
 * from a server that had thrown a pooler error it understood perfectly well. Two defects
 * were behind it, and both are properties of the connection rather than of any route:
 *
 *   1. ONE CONNECTION CARRIED CONCURRENT STATEMENTS. A request scope holds one connection,
 *      because that is where the RLS context and `firm_api` live — and several places read
 *      four or five independent facts at once with `Promise.all`, the authorization facts
 *      among them. node-postgres answers the second query on a busy client with a
 *      deprecation warning; interleaved statements on one connection are how a query ends
 *      up outside the savepoint that was supposed to contain it.
 *
 *   2. A LOST CONNECTION LOOKED LIKE A BROKEN SERVER. The pooler refusing a connection, a
 *      cold instance timing out, an idle socket closed underneath us — all transient, all
 *      reported as `internal_error`, all indistinguishable to the person signing in from an
 *      actual bug. And on a serverless runtime each instance held three session-pooler
 *      connections while the number of instances is elastic, which is what exhausted the
 *      pooler in the first place.
 *
 * These are verified against a pool that can be made to fail on purpose, because the
 * behaviour under a broken connection cannot be observed any other way: a driver that only
 * works when the network works is a driver nobody has tested.
 */
import { describe, it, expect, vi } from 'vitest';
import { PostgresDb } from '../../server/src/db/postgres.js';
import { isTransientConnectionError, defaultPoolMax } from '../../server/src/db/transient.js';
import { toPortalError } from '../../server/src/lib/errors.js';

/** A client that notices when it is asked to do two things at once. */
class FakeClient {
  inFlight = 0;
  maxInFlight = 0;
  readonly queries: string[] = [];
  released = 0;
  private n = 0;

  constructor(
    private readonly behave: (sql: string, n: number) => Error | null = () => null,
  ) {}

  async query(sql: string) {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    this.queries.push(sql);
    this.n += 1;
    /* A socket is not instantaneous, and a serializer that is correct only for
       zero-latency queries is not a serializer. */
    await new Promise((r) => setTimeout(r, 5));
    try {
      const failure = this.behave(sql, this.n);
      if (failure) throw failure;
      return { rows: [], rowCount: 0 };
    } finally {
      this.inFlight -= 1;
    }
  }

  release() {
    this.released += 1;
  }

  /** A real connection can be closed, and a leaked one has to be. */
  ended = false;
  async end(): Promise<void> {
    this.ended = true;
  }
}

class FakePool {
  connects = 0;
  readonly clients: FakeClient[] = [];

  constructor(
    private readonly make: () => FakeClient = () => new FakeClient(),
    private readonly failConnect: (attempt: number) => Error | null = () => null,
  ) {}

  async connect(): Promise<FakeClient> {
    this.connects += 1;
    const failure = this.failConnect(this.connects);
    if (failure) throw failure;
    const client = this.make();
    this.clients.push(client);
    return client;
  }

  on(): this {
    return this;
  }

  async end(): Promise<void> {
    /* nothing to close */
  }
}

const transient = () => Object.assign(new Error('Connection terminated unexpectedly'), { code: '08006' });
const refused = () => Object.assign(new Error('remaining connection slots are reserved'), { code: '53300' });
const typo = () => Object.assign(new Error('column "clientss" does not exist'), { code: '42703' });

const build = (pool: FakePool) =>
  new PostgresDb('postgres://portal_api@example.invalid:5432/postgres', 3, pool as never);

/**
 * `pg` mocked, so the POOL ITSELF is observable: how many were built, which one was
 * closed, and whether a closed one was ever reused. `connect()` keeps the counts a real
 * pool keeps — a client is checked out (`idleCount` 0) until it is released — because the
 * drain guard reads exactly those counts, and a stub with invented ones would agree with
 * any implementation.
 */
async function withMockedPg() {
  vi.resetModules();
  const built: {
    options: Record<string, unknown>;
    idleCount: number;
    totalCount: number;
    waitingCount: number;
    ended: boolean;
    busy: boolean;
  }[] = [];

  class MockPool {
    options: Record<string, unknown>;
    idleCount = 0;
    totalCount = 0;
    waitingCount = 0;
    ended = false;
    lastClient: FakeClient | undefined;
    private _busy = false;

    /** A second request on this container is mid-query: nothing is on the shelf. */
    get busy(): boolean {
      return this._busy;
    }
    set busy(value: boolean) {
      this._busy = value;
      this.idleCount = value ? 0 : this.totalCount;
    }

    constructor(options: Record<string, unknown>) {
      this.options = options;
      built.push(this);
    }

    on(): this {
      return this;
    }

    async connect(): Promise<FakeClient> {
      this._busy = true;
      this.idleCount = 0;
      this.totalCount = Math.max(this.totalCount, 1);
      const pool = this;
      const client = new FakeClient();
      this.lastClient = client;
      const released = client.release.bind(client);
      client.release = () => {
        released();
        pool.idleCount = pool.totalCount;
        pool.busy = false;   // through the accessor: nothing is checked out any more
      };
      return client;
    }

    async query(): Promise<{ rows: never[] }> {
      return { rows: [] };
    }

    async end(): Promise<void> {
      this.ended = true;
      this.totalCount = 0;
      this.idleCount = 0;
    }
  }

  vi.doMock('pg', () => ({ default: { Pool: MockPool } }));
  const { PostgresDb: Driver } = await import('../../server/src/db/postgres.js');
  return { PostgresDb: Driver, built };
}

describe('the connection discipline the driver promises', () => {
  it('never issues two statements on one connection at once, even under Promise.all', async () => {
    const pool = new FakePool();
    const db = build(pool);
    const scope = await db.acquire();

    /* This is what an authorization load and a dozen route bodies actually do. */
    await Promise.all([
      scope.q.get('select 1'),
      scope.q.get('select 2'),
      scope.q.all('select 3'),
      scope.q.run('select 4'),
    ]);

    const client = pool.clients[0];
    expect(client.maxInFlight).toBe(1);
    /* And the order asked for is the order issued: no reordering across the queue. */
    expect(client.queries).toEqual(['select 1', 'select 2', 'select 3', 'select 4']);
    await scope.end();
  });

  it('keeps BEGIN, the body and COMMIT in order on that same connection', async () => {
    const pool = new FakePool();
    const db = build(pool);
    const scope = await db.acquire();

    await scope.tx(async () => {
      await scope.q.run('insert into one');
      await Promise.all([scope.q.run('insert into two'), scope.q.run('insert into three')]);
    });

    expect(pool.clients[0].queries).toEqual([
      'BEGIN', 'insert into one', 'insert into two', 'insert into three', 'COMMIT',
    ]);
    expect(pool.clients[0].maxInFlight).toBe(1);
    await scope.end();
  });

  it('resets the role and the GUCs only after the last statement of the request', async () => {
    const pool = new FakePool();
    const db = build(pool);
    const scope = await db.acquire();

    await scope.setContext({ phase: 'firm', tenantId: 't', userId: 'u', clientIds: [], membershipId: 'm' });
    await scope.q.get('select 1');
    await scope.end();

    const queries = pool.clients[0].queries;
    expect(queries.indexOf('RESET ROLE')).toBeGreaterThan(queries.indexOf('select 1'));
    expect(queries.indexOf('RESET ALL')).toBeGreaterThan(queries.indexOf('RESET ROLE'));
    /* A connection that goes back to the pool holding firm_api would serve the next
       request — plausibly a client-portal one — with the firm role's policies. */
    expect(pool.clients[0].released).toBe(1);
  });

  it('retries a refused connection instead of reporting it as an internal error', async () => {
    const pool = new FakePool(undefined, (attempt) => (attempt <= 2 ? refused() : null));
    const db = build(pool);

    await db.all('select 1');
    expect(pool.connects).toBe(3);
  });

  it('waits out a pooler that is at its client limit rather than failing the request', async () => {
    /* The real thing: Supavisor answering the sixteenth session with EMAXCONNSESSION.
       The ladder this test exercises end to end is the ladder production runs: seven
       attempts and about ten seconds of patience for a resource that is merely busy. */
    const saturated = Object.assign(
      new Error('(EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: 15'),
      { code: 'XX000' },
    );
    const pool = new FakePool(undefined, (attempt) => (attempt <= 4 ? saturated : null));
    const db = build(pool);

    await db.all('select 1');
    /* Five attempts, the first four of which waited 250/500/1000/2000 ms: a genuine burst
       of cold containers outlasts a hiccup, so the ladder has to outlast the burst. */
    expect(pool.connects).toBe(5);
  }, 15_000);

  it('does not retry a failure that is about the statement', async () => {
    const pool = new FakePool(undefined, () => typo());
    const db = build(pool);

    await expect(db.all('select 1')).rejects.toThrow(/clientss/);
    expect(pool.connects).toBe(1);
  });

  it('repeats a READ that died on a dead connection, and does not repeat a WRITE', async () => {
    /* The read: the first connection dies mid-statement, the retry is answered. */
    let readAttempt = 0;
    const readPool = new FakePool(() => new FakeClient(() => (++readAttempt === 1 ? transient() : null)));
    const readDb = build(readPool);
    await readDb.all('select 1');
    expect(readPool.connects).toBe(2);

    /* The write: the same failure, and it must NOT be sent twice — the server may have
       applied it before the connection died, and a retry there is how a payment is
       recorded twice. */
    let writeAttempt = 0;
    const writePool = new FakePool(() => new FakeClient(() => (++writeAttempt === 1 ? transient() : null)));
    const writeDb = build(writePool);
    await expect(writeDb.run('update ledger set paid = true')).rejects.toThrow(/Connection terminated/);
    expect(writePool.clients[0].queries).toEqual(['update ledger set paid = true']);
  });
});

describe('what a transient failure looks like to the person at the desk', () => {
  it('is a 503 that says it is retryable, not a 500 that says "something unexpected"', () => {
    const pe = toPortalError(transient());
    expect(pe.status).toBe(503);
    expect(pe.code).toBe('service_unavailable');
    expect(pe.retryable).toBe(true);
    expect(pe.safeDetails?.retryable).toBe(true);
  });

  it('still hides the driver detail, and still reports a real bug as a 500', () => {
    const pe = toPortalError(transient());
    expect(pe.message).not.toContain('Connection terminated');
    expect(pe.internalCause).toBeTruthy();

    const bug = toPortalError(new Error('cannot read properties of undefined'));
    expect(bug.status).toBe(500);
    expect(bug.code).toBe('internal_error');
    expect(bug.retryable).toBeFalsy();
  });

  it('knows the pooler by name, and answers it with a 503 rather than a shrug', () => {
    const saturated = Object.assign(
      new Error('(EMAXCONNSESSION) max clients reached in session mode'),
      { code: 'XX000' },
    );
    /* `XX000` is the generic internal-error state, so the SQLSTATE tells us nothing —
       the message is the only signal, and it is the failure that took the site down. */
    expect(isTransientConnectionError(saturated)).toBe(true);
    expect(toPortalError(saturated).status).toBe(503);
    expect(toPortalError(saturated).code).toBe('service_unavailable');
  });

  it('gives the session back instead of holding it while warm', () => {
    /* Constructed for real, because this is a property of the pool rather than of a
       query: a warm serverless instance holding a session pooler connection spends the
       whole fleet's budget on itself. */
    const db = new PostgresDb('postgres://portal_api@example.invalid:5432/postgres', 1);
    const options = (db as unknown as { pool: { options: Record<string, unknown> } }).pool.options;
    expect(options.max).toBe(1);
    expect(options.idleTimeoutMillis).toBe(1_000);
    expect(options.allowExitOnIdle).toBe(true);
  });

  it('hands its sessions back when the response is done, and opens a new one next time', async () => {
    /*
      THE OUTAGE, AS A TEST.

      Measured on the deployed system with the idle timeout already down to one second:

          portal_api sessions: 15, state=idle, untouched for 120s

      Fifteen of the pooler's fifteen slots, held by fifteen suspended containers whose
      event loops were frozen and whose timers therefore never fired. A timeout cannot fix
      that, so the close is explicit: `drain()` after the response is flushed, and a new
      pool when the container is asked to do something again.

      `pg` is mocked here for one reason: the identity of the pool is the thing under test.
      A drain must CLOSE the pool it was holding rather than hand it back, and the next
      statement must run on a different one.
    */
    const { PostgresDb: Driver, built } = await withMockedPg();
    const db = new Driver('postgres://portal_api@example.invalid:5432/postgres', 1);

    await db.all('select 1');
    expect(built).toHaveLength(1);

    await db.drain();
    expect(built[0].ended).toBe(true);

    await db.all('select 1');
    expect(built).toHaveLength(2);
    expect(built[1].ended).toBe(false);

    vi.doUnmock('pg');
    vi.resetModules();
  });

  it('waits for the request scope that closes after the response is already flushed', async () => {
    /*
      THE MILLIMETRE BETWEEN TWO CORRECT PIECES OF CODE, WHICH IS WHERE THIS BUG LIVED.

      The auth middleware releases its scope from `res.once('finish')` — deliberately, so
      that a response is never held up by two RESET round trips. The drain therefore runs
      while the scope is still open, and a drain that believed the pool's counts at that
      moment would skip itself, every single time, on every container: exactly the fifteen
      idle sessions that were measured holding the whole fleet's budget. So the driver
      counts the scopes it has handed out and waits for them, which is what this pins.
    */
    const { PostgresDb: Driver, built } = await withMockedPg();
    const db = new Driver('postgres://portal_api@example.invalid:5432/postgres', 1);

    const scope = await db.acquire();
    setTimeout(() => {
      void scope.end();                       // the `res.on('finish')` handler, a tick later
    }, 50);

    await db.drain();

    expect(built[0].ended).toBe(true);
    expect(built).toHaveLength(1);

    vi.doUnmock('pg');
    vi.resetModules();
  });

  it('closes a connection whose request was killed, and throws the pool away', async () => {
    /*
      THE CORPSE IN THE WARM CONTAINER.

      A request that is killed — budget exhausted, instance recycled — never reaches the
      code that hands its connection back. Its socket stays attached to the pooler while
      the container keeps serving new requests, and fifteen of those take the whole fleet
      down: measured after a storm of concurrent sign-ins, fifteen backends held and a
      new client refused from anywhere, including outside Vercel. Nothing on the client
      side can reclaim it; only the container that holds it can let go.

      A scope that has been open for twenty seconds is not a request in flight — this API
      answers in well under a second and the connect ladder alone accounts for ten — so it
      is closed, and the pool goes with it.
    */
    const { PostgresDb: Driver, built } = await withMockedPg();
    const db = new Driver('postgres://portal_api@example.invalid:5432/postgres', 1);

    await db.acquire();                         // and then: killed. No `end()` ever runs.
    const internals = db as unknown as { scopes: Map<unknown, number> };
    for (const [client] of internals.scopes) internals.scopes.set(client, Date.now() - 60_000);

    await db.drain();

    expect(built[0].lastClient?.ended).toBe(true);
    expect(built[0].ended).toBe(true);

    await db.all('select 1');                   // the next request gets a fresh pool
    expect(built).toHaveLength(2);

    vi.doUnmock('pg');
    vi.resetModules();
  });

  it('buries the corpse before asking for a connection of its own', async () => {
    /*
      The difference between recovering in seconds and recovering in four and a half
      minutes. `heal()` runs at the START of a request, before the role check — which is
      itself a request for a connection. A container holding a session for a request that
      was killed therefore releases it and THEN asks for one, instead of being refused,
      failing, and only then letting go (measured on the deployment: 277 seconds of
      refusals, healed one lost request at a time).
    */
    const { PostgresDb: Driver, built } = await withMockedPg();
    const db = new Driver('postgres://portal_api@example.invalid:5432/postgres', 1);

    await db.acquire();
    const internals = db as unknown as { scopes: Map<unknown, number> };
    for (const [client] of internals.scopes) internals.scopes.set(client, Date.now() - 60_000);

    db.heal();                                  // synchronous on purpose: no waiting here

    expect(built[0].lastClient?.ended).toBe(true);

    vi.doUnmock('pg');
    vi.resetModules();
  });

  it('will not heal a container while a live request is using it', async () => {
    /* The one thing `heal()` must never do. If any open scope is recent, it does nothing:
       a container with a live request in it is not a container that needs burying. */
    const { PostgresDb: Driver, built } = await withMockedPg();
    const db = new Driver('postgres://portal_api@example.invalid:5432/postgres', 1);

    await db.acquire();                         // this request is in flight
    db.heal();

    expect(built[0].lastClient?.ended).toBe(false);
    expect(built[0].ended).toBe(false);

    vi.doUnmock('pg');
    vi.resetModules();
  });

  it('leaves a slow request alone — only corpses are force-closed', async () => {
    /* The counterpart, and the reason the age is recorded at all: closing the connection
       under a request that is merely slow would break a real request to tidy up a real
       one. */
    const { PostgresDb: Driver, built } = await withMockedPg();
    const db = new Driver('postgres://portal_api@example.invalid:5432/postgres', 1);

    const scope = await db.acquire();
    await db.drain();

    expect(built[0].lastClient?.ended).toBe(false);
    expect(built[0].ended).toBe(false);

    await scope.end();                          // it finishes normally, as most do
    vi.doUnmock('pg');
    vi.resetModules();
  });

  it('does not close a pool that another request on this instance is still using', async () => {
    /*
      One container can answer more than one request at a time. A drain that closed the
      pool under a running request would fail that request for no reason — so a drain is
      skipped while anything is checked out, and the request that finishes last closes the
      door. This is why the guard is on the pool's own counts rather than a flag of ours.
    */
    const { PostgresDb: Driver, built } = await withMockedPg();
    const db = new Driver('postgres://portal_api@example.invalid:5432/postgres', 1);

    await db.all('select 1');
    built[0].busy = true;                       // a second request is mid-query

    await db.drain();
    expect(built[0].ended).toBe(false);
    expect(built).toHaveLength(1);              // and nothing was rebuilt behind its back

    vi.doUnmock('pg');
    vi.resetModules();
  });

  it('never closes a pool a test supplied', async () => {
    /* The injected pool is a seam for tests, not a resource this class opened. */
    const pool = new FakePool();
    const db = build(pool);
    await db.drain();
    expect(pool.connects).toBe(0);
    await db.all('select 1');
    expect(pool.connects).toBe(1);
  });

  it('recognises the failures worth retrying, and none of the ones that are not', () => {
    for (const state of ['08006', '53300', '57P01', '08001']) {
      expect(isTransientConnectionError(Object.assign(new Error('x'), { code: state }))).toBe(true);
    }
    for (const state of ['42703', '23505', '23514', '42P01']) {
      expect(isTransientConnectionError(Object.assign(new Error('x'), { code: state }))).toBe(false);
    }
    /* A guard's refusal is permanent, and must never be retried into a slow 503. */
    expect(isTransientConnectionError(new Error('cdd_missing: no record'))).toBe(false);
  });

  it('sizes the pool to the runtime, because the pooler is shared with every instance', () => {
    expect(defaultPoolMax({ PG_POOL_MAX: '3' } as NodeJS.ProcessEnv)).toBe(3);
    expect(defaultPoolMax({ VERCEL: '1' } as NodeJS.ProcessEnv)).toBe(1);
    expect(defaultPoolMax({ AWS_LAMBDA_FUNCTION_NAME: 'x' } as NodeJS.ProcessEnv)).toBe(1);
    expect(defaultPoolMax({} as NodeJS.ProcessEnv)).toBe(10);
  });
});
