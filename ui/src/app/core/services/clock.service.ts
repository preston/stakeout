import { Service, signal } from '@angular/core';

/** Ticks periodically so relative-time displays stay current without impure pipes. */
@Service()
export class ClockService {
  private static readonly TICK_MS = 30_000;

  private readonly tick = signal(Date.now());
  readonly now = this.tick.asReadonly();

  constructor() {
    if (typeof window !== 'undefined') {
      this.tick.set(Date.now());
      setInterval(() => this.tick.set(Date.now()), ClockService.TICK_MS);
    }
  }
}
