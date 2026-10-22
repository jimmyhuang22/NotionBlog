export interface ScheduledResult {
  exitCode: number;
  published?: boolean;
  readerVerified?: boolean;
  runId?: string;
  [key: string]: unknown;
}
export interface ScheduledPorts {
  run: (options: { configFile: string; mode: 'publish' }) => Promise<ScheduledResult>;
  notify: (kind: 'completed' | 'failed') => Promise<void>;
}
export function runScheduledWebsite(configFile: string, ports?: ScheduledPorts): Promise<ScheduledResult>;
