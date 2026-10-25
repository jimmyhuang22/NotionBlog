import type { Server } from 'node:http';
export function drainSelfHostedServer(server: Server, app: { close(): Promise<unknown> }, closePools: () => Promise<number>): Promise<number>;
