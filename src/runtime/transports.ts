import type { FetchLike } from './broker.js';
import { sqlQueries, type DbRequest, type DbResult } from './databases.js';
import { mongo, runMongoOperation } from './db-mongo.js';
import { sqlServer } from './db-mssql.js';
import { mysql } from './db-mysql.js';
import { postgres } from './db-postgres.js';
import type { EgressPolicy, Resolver } from './egress.js';
import type { Target, TransportMakers, Transports } from './protocols.js';
import type { Dialect } from './sql.js';
import { amqp } from './transport-amqp.js';
import { mqtt } from './transport-mqtt.js';
import { smtp } from './transport-smtp.js';
import { sse } from './transport-sse.js';
import { ws } from './transport-ws.js';

/** Every transport, for a server that runs any module (an exported app takes only the ones its modules use). */

const SQL = { postgres, mysql, mssql: sqlServer };

export const ALL_TRANSPORTS: Required<TransportMakers> = {
  smtp,
  amqp,
  mqtt,
  ws,
  sse,
  db: (policy) => sqlQueries(SQL, policy),
  mongo,
};

export function realTransports(policy: EgressPolicy, fetchImpl?: FetchLike): Transports {
  return {
    smtp: smtp(policy, fetchImpl),
    amqp: amqp(policy, fetchImpl),
    mqtt: mqtt(policy, fetchImpl),
    ws: ws(policy, fetchImpl),
    sse: sse(policy, fetchImpl),
    db: sqlQueries(SQL, policy),
    mongo: mongo(policy, fetchImpl),
  };
}

/** Run one checked query against a real database. */
export function runDbQuery(dialect: Dialect, t: Target, r: DbRequest, policy: EgressPolicy, resolve?: Resolver): Promise<DbResult> {
  return sqlQueries(SQL, policy, resolve)(dialect, t, r);
}

export { runMongoOperation };
