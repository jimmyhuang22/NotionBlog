export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { configureExecutionEnvironment } = await import('../scripts/development/execution.ts');
    configureExecutionEnvironment(process.env);
  }
}
