import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { privateFolder, privateLock, privateRead, privateWrite } from "./private-store.ts";
import { RESPONSE_ENVELOPE_BYTES, type SqlReservation, type SqlResponseBudget } from "./projection.ts";

export interface OperatorSqlPlan {
  version: 1;
  session: string;
  stopAt: number;
  maxQueries: number;
  maxResponseBytes: number;
  maxQueryResponseBytes: number;
}
interface State {
  version: 1; planDigest: string; queries: number; receivedBytes: number; reservedBytes: number;
  stopped: string | null; reservations: Record<string, { bytes: number; at: number }>;
}
/** Same private directory/immutable plan shares reservations across sequential
 * stages and processes. Open-existing never resets spent bytes or failures. */
export async function createOperatorSqlBudget(directory: string, requestedPlan: OperatorSqlPlan, now = Date.now): Promise<SqlResponseBudget & { statistics(): Promise<State> }> {
  const plan = Object.freeze({ ...requestedPlan });
  if (Object.keys(plan).sort().join(",") !== "maxQueries,maxQueryResponseBytes,maxResponseBytes,session,stopAt,version" ||
      plan.version !== 1 || !/^[a-f0-9]{64}$/.test(plan.session) || !Number.isSafeInteger(plan.stopAt) ||
      plan.stopAt <= now() || plan.stopAt > now() + 24 * 60 * 60 * 1000 ||
      !Number.isSafeInteger(plan.maxQueries) || plan.maxQueries < 1 || plan.maxQueries > 20000 ||
      !Number.isSafeInteger(plan.maxResponseBytes) || plan.maxResponseBytes < RESPONSE_ENVELOPE_BYTES || plan.maxResponseBytes > 256 * 1024 ** 2 ||
      !Number.isSafeInteger(plan.maxQueryResponseBytes) || plan.maxQueryResponseBytes < RESPONSE_ENVELOPE_BYTES || plan.maxQueryResponseBytes > plan.maxResponseBytes)
    throw Error("OPERATOR_SQL_PLAN_INVALID");
  const digest = createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(plan).sort()))).digest("hex");
  const created = await privateFolder(directory);
  const path = join(directory, "state.json"), lock = join(directory, ".budget.lock");
  const load = async () => {
    const state: State = JSON.parse(await privateRead(path, 4 * 1024 * 1024));
    if (state.version !== 1 || state.planDigest !== digest || !Number.isSafeInteger(state.queries) || state.queries < 0 || state.queries > plan.maxQueries ||
        !Number.isSafeInteger(state.receivedBytes) || state.receivedBytes < 0 || !Number.isSafeInteger(state.reservedBytes) || state.reservedBytes < 0 ||
        state.receivedBytes + state.reservedBytes > plan.maxResponseBytes ||
        !state.reservations || typeof state.reservations !== "object" || Array.isArray(state.reservations) ||
        Object.values(state.reservations).some(v => !Number.isSafeInteger(v.bytes) || v.bytes < RESPONSE_ENVELOPE_BYTES || !Number.isSafeInteger(v.at)) ||
        Object.values(state.reservations).reduce((n, v) => n + v.bytes, 0) !== state.reservedBytes ||
        !(state.stopped === null || typeof state.stopped === "string")) throw Error("OPERATOR_SQL_LEDGER_INVALID");
    return state;
  };
  const save = (state: State) => privateWrite(path, JSON.stringify(state) + "\n");
  await privateLock(lock, async () => {
    try {
      const state = await load();
      if (Object.keys(state.reservations).length) {
        state.stopped ??= "UNSETTLED_REOPEN"; await save(state);
      }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!created) throw Error("OPERATOR_SQL_LEDGER_MISSING");
      await save({ version: 1, planDigest: digest, queries: 0, receivedBytes: 0, reservedBytes: 0, stopped: null, reservations: {} });
    }
  });
  return {
    statistics: () => privateLock(lock, load),
    reserve: () => privateLock(lock, async () => {
      const state = await load();
      const remaining = plan.maxResponseBytes - state.receivedBytes - state.reservedBytes;
      if (state.stopped || now() >= plan.stopAt || state.queries >= plan.maxQueries || remaining < RESPONSE_ENVELOPE_BYTES ||
          Object.values(state.reservations).some(v => now() - v.at >= 60000)) {
        state.stopped ??= "LIMIT_DEADLINE_OR_UNSETTLED_QUERY"; await save(state); throw Error("OPERATOR_SQL_BUDGET_STOPPED");
      }
      const reservation = { id: randomUUID(), bytes: Math.min(plan.maxQueryResponseBytes, remaining) };
      state.reservations[reservation.id] = { bytes: reservation.bytes, at: now() };
      state.queries++; state.reservedBytes += reservation.bytes; await save(state);
      return reservation;
    }),
    settle: (reservation, bytes) => privateLock(lock, async () => {
      const state = await load(), pending = state.reservations[reservation.id];
      if (!pending || pending.bytes !== reservation.bytes || !Number.isSafeInteger(bytes) || bytes < RESPONSE_ENVELOPE_BYTES || bytes > pending.bytes)
        throw Error("OPERATOR_SQL_RESERVATION_INVALID");
      delete state.reservations[reservation.id]; state.reservedBytes -= pending.bytes; state.receivedBytes += bytes;
      if (now() >= plan.stopAt) state.stopped ??= "DEADLINE";
      await save(state);
      if (state.stopped) throw Error("OPERATOR_SQL_BUDGET_STOPPED");
    }),
    fail: (reservation, reason) => privateLock(lock, async () => {
      const state = await load(), pending = state.reservations[reservation.id];
      if (pending) {
        if (pending.bytes !== reservation.bytes) throw Error("OPERATOR_SQL_RESERVATION_INVALID");
        delete state.reservations[reservation.id]; state.reservedBytes -= pending.bytes;
        // The outcome is unknown: conservatively consume its whole allowance.
        state.receivedBytes += pending.bytes;
      }
      state.stopped ??= /^[A-Z_]{1,80}$/.test(reason) ? reason : "QUERY_FAILED";
      await save(state);
    }),
  };
}
