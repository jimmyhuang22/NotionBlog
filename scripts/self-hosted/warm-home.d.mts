import type { IncomingMessage, ServerResponse } from 'node:http';

export function warmSelfHostedHome(
  handle: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  env: Record<string, string | undefined>,
  options?: { timeoutMs?: number; maxBytes?: number },
): Promise<{ outcome: 'skipped' | 'ready' | 'unavailable'; durationMs?: number; bytes?: number }>;
