import {MAXIMUM_RETURNED_BYTES} from "./limits.ts";

const functions = ["plan", "archive_schema", "archive_index", "archive_payload", "fingerprint", "delete_chunk"];
const envelopeReserve = 256;

/** Bounds returned JSON inside the transaction, before a write can commit. This is a
 * logical result budget, not a claim about PostgreSQL protocol or TLS wire bytes. */
export class RetentionResponseBudget {
  remaining: number;

  constructor(maximum = MAXIMUM_RETURNED_BYTES) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAXIMUM_RETURNED_BYTES) {
      throw Error("RETENTION_RESPONSE_BUDGET_INVALID");
    }
    this.remaining = maximum;
  }

  query(name: string, args: unknown[]) {
    if (!functions.includes(name)) throw Error("RETENTION_RPC_INVALID");
    if (this.remaining <= envelopeReserve) throw Error("RETENTION_RESPONSE_BUDGET");
    const placeholders = args.map((_, i) => `$${i + 1}`).join(",");
    const maximum = `$${args.length + 1}::integer`;
    return {
      text: `WITH reply AS MATERIALIZED (SELECT nb_retention_api.${name}(${placeholders}) AS result)
        SELECT octet_length(result::text) AS bytes,
          CASE WHEN octet_length(result::text) <= ${maximum} THEN result ELSE NULL END AS result
        FROM reply`,
      values: [...args, this.remaining - envelopeReserve],
    };
  }

  accept<T>(row: {bytes: number; result: T | null}): T {
    const remaining = this.remaining;
    this.charge(row);
    if (!Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > remaining - envelopeReserve || row.result === null) {
      throw Error("RETENTION_RESPONSE_BUDGET");
    }
    return row.result;
  }

  charge(value: unknown) {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > this.remaining) throw Error("RETENTION_RESPONSE_BUDGET");
    this.remaining -= bytes;
  }
}
