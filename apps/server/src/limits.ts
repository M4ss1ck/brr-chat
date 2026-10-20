// Fixed-window abuse budgets (ADR 0012). Counters live in memory beside the log: a restart
// forgets them, exactly like the recovery limiter, and never forgets an account.
// Limits are per account (wire id or BetterAuth id) and, for signups, per IP.

export interface AbuseLimitConfig {
  /** Posts and DMs together, per account, in one minute. */
  messagesPerMinute: number;
  /** Brand-new DM threads per account, in one day. */
  newDmThreadsPerDay: number;
  /** New accounts per IP, in one hour. */
  signupsPerHour: number;
  /** How old an account must be before it may open a DM thread. */
  dmCooldownSeconds: number;
}

/** The numbers in ADR 0012. Every one of them is configurable so tests can shrink a window. */
export const DEFAULT_ABUSE_LIMITS: AbuseLimitConfig = {
  messagesPerMinute: 30,
  newDmThreadsPerDay: 10,
  signupsPerHour: 3,
  dmCooldownSeconds: 24 * 60 * 60,
};

export interface GateResult {
  allowed: boolean;
  /** Whole seconds until the window resets; 0 when allowed. */
  retryAfter: number;
}

/** What sign-up needs from a counter: reserve a slot, then give it back if the request failed. */
export interface SignupBudget {
  consume(key: string, now: number): GateResult;
  refund(key: string, now: number): void;
}

/**
 * One fixed window per key. The first hit starts a window; everything until its reset counts
 * against the same budget. Small and boring on purpose: no timers, no clock skew, no storage.
 */
export class FixedWindowCounter implements SignupBudget {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly windowMs: number,
    private readonly max: number,
  ) {}

  /**
   * Spends one unit when the window has room. The check and the increment happen together, so
   * concurrent requests cannot all pass the same slot. `refund` gives a reservation back if the
   * work it guarded failed.
   */
  consume(key: string, now: number): GateResult {
    this.prune(now);
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      if (this.max <= 0) return { allowed: false, retryAfter: Math.max(1, Math.ceil(this.windowMs / 1000)) };
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, retryAfter: 0 };
    }
    if (bucket.count >= this.max) {
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
    }
    bucket.count += 1;
    return { allowed: true, retryAfter: 0 };
  }

  /** Counts one hit when there is room. Returns false instead of spending when there is not. */
  hit(key: string, now: number): boolean {
    return this.consume(key, now).allowed;
  }

  /** Gives back a reservation that did not turn into work. */
  refund(key: string, now: number): void {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) return;
    bucket.count -= 1;
    if (bucket.count <= 0) this.buckets.delete(key);
  }

  /** Drop expired keys so a long-lived server does not grow one map forever. */
  private prune(now: number): void {
    if (this.buckets.size <= 10_000) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

/** The three budgets the server enforces, one counter each. */
export class AbuseLimiters {
  private readonly messages: FixedWindowCounter;
  private readonly dmThreads: FixedWindowCounter;
  readonly signups: SignupBudget;

  constructor(readonly config: AbuseLimitConfig = DEFAULT_ABUSE_LIMITS) {
    this.messages = new FixedWindowCounter(60_000, config.messagesPerMinute);
    this.dmThreads = new FixedWindowCounter(24 * 60 * 60 * 1000, config.newDmThreadsPerDay);
    this.signups = new FixedWindowCounter(60 * 60 * 1000, config.signupsPerHour);
  }

  /** Posts and DMs draw from the same per-account minute. */
  allowsMessage(accountId: string, nowMs: number): boolean {
    return this.messages.hit(accountId, nowMs);
  }

  /** Only actually creating a new DM scope draws from the daily thread budget. */
  allowsNewDmThread(accountId: string, nowMs: number): boolean {
    return this.dmThreads.hit(accountId, nowMs);
  }

  /** An op that reserved a thread but was rejected for another reason created no thread. */
  refundNewDmThread(accountId: string, nowMs: number): void {
    this.dmThreads.refund(accountId, nowMs);
  }
}
