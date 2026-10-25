import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { Pool, type PoolClient, type QueryConfig } from "pg";

/** Keep route fixtures on their injected SQL executor when the real request
 * budget switches production from pool.query to a checked-out client. */
export function installMediaRouteCheckout() {
  const original = Pool.prototype.connect;
  Pool.prototype.connect = function (this: Pool, callback: (error: Error | null, client: PoolClient) => void) {
    const client = Object.assign(new EventEmitter(), {
      query: (config: QueryConfig & { query_timeout: number }) => {
        assert.ok(config.query_timeout > 0 && config.query_timeout <= 20000);
        return this.query(config.text, config.values);
      },
      release: () => {},
    });
    callback(null, client as unknown as PoolClient);
  } as typeof Pool.prototype.connect;
  return () => { Pool.prototype.connect = original; };
}
