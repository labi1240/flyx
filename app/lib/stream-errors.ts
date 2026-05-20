export class AllProvidersFailedError extends Error {
  attempts: { provider: string; error: string }[];

  constructor(attempts: { provider: string; error: string }[]) {
    const msg = 'All providers failed';
    super(msg);
    this.name = 'AllProvidersFailedError';
    this.attempts = attempts;
  }
}
