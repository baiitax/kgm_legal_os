/**
 * TRANSIENT FAILURES — THE ONES THAT ARE WORTH TRYING AGAIN.
 *
 * A serverless deployment holds a small, elastic set of processes, each with its own
 * connection to the Supabase pooler. Under load the pooler refuses a new connection
 * (`53300 too_many_connections`), an idle connection is closed underneath us
 * (`Connection terminated unexpectedly`, `57P01`), a cold instance's connect exceeds
 * its timeout, or the socket dies in the middle of nowhere (`ECONNRESET`,
 * `EPIPE`, `ETIMEDOUT`). None of those is a bug in the request; all of them look
 * identical to a bug from the outside, which is why they were surfacing to the user
 * as "The request could not be completed. Something unexpected went wrong."
 *
 * The distinction this module exists to draw:
 *
 *   · a TRANSIENT failure means the request never ran, so trying it again is safe;
 *   · anything else is a real failure and must not be retried or disguised.
 *
 * The patterns are matched against Postgres's SQLSTATE as well as the driver's
 * English, because the message text is not a contract. Callers must still decide
 * what they are allowed to retry: `all`/`get` are safe to repeat; a write is only
 * safe to repeat when the failure happened while ACQUIRING a connection, before
 * any statement was sent.
 */

/** SQLSTATEs that mean "this connection failed", not "this statement was wrong". */
const TRANSIENT_SQLSTATE = new Set([
  '08000', // connection_exception
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08003', // connection_does_not_exist
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
  '08006', // connection_failure
  '08007', // transaction_resolution_unknown
  '53300', // too_many_connections
  '53400', // configuration_limit_exceeded
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
]);

/** The driver's own words for the same thing. Deliberately narrow. */
const TRANSIENT_MESSAGE = new RegExp([
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH',
  'Connection terminated', 'connection is closed', 'server closed the connection',
  'Client has encountered a connection error',
  'timeout expired', 'Connection terminated unexpectedly',
  'remaining connection slots are reserved', 'too many clients already',
  'Timed out fetching a new connection from the connection pool',
].join('|'), 'i');

function sqlStateOf(err: unknown): string | null {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' ? code : null;
}

/**
 * True when a failure is about the CONNECTION rather than about the statement.
 *
 * A unique-violation, a CHECK constraint, a missing column and an RLS refusal are all
 * permanent: they will fail identically on the next attempt, and retrying them would
 * turn a clear 4xx into a slow 503.
 */
export function isTransientConnectionError(err: unknown): boolean {
  const state = sqlStateOf(err);
  if (state && TRANSIENT_SQLSTATE.has(state)) return true;

  const seen = new Set<unknown>();
  let cursor: unknown = err;
  while (cursor instanceof Error && !seen.has(cursor)) {
    seen.add(cursor);
    if (TRANSIENT_MESSAGE.test(cursor.message)) return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * How many connections one process may hold, and why it is not a constant.
 *
 * The Supabase session pooler on 5432 is what this application needs — `SET ROLE` and
 * session-scoped `set_config()` do not survive transaction pooling on 6543, and the RLS
 * model depends on both. A session is a connection, so the pool size of a process
 * multiplied by the number of live processes is the real budget. On a long-lived server
 * that is one process times ten. On a serverless platform it is N processes of which the
 * operator knows only that N is elastic, and a large per-process pool spends the whole
 * budget on instances nobody is waiting for.
 *
 * `PG_POOL_MAX` remains the operator's setting and is honoured; the default is what
 * changes on a serverless runtime, and the boot log states the number it chose.
 */
export function defaultPoolMax(env: NodeJS.ProcessEnv = process.env): number {
  if (env.PG_POOL_MAX) return Number(env.PG_POOL_MAX);
  return env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME ? 1 : 10;
}
