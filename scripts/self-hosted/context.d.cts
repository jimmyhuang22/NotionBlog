export function configureSelfHostedEnvironment(env: NodeJS.ProcessEnv): 'self-hosted-build' | 'self-hosted' | undefined;
export function registerSelfHostedPool(pool: { end(): Promise<unknown> }): boolean;
export function closeSelfHostedPools(): Promise<number>;
export function isSelfHostedRuntime(): boolean;
