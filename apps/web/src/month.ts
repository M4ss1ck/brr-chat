// One definition of the meter's calendar-month key (ADR 0018). The device's local month is
// both the storage key and the rollover boundary, so the constructor and the validator live
// together instead of being re-written as regexes beside each caller.

/** The device's local calendar month, `YYYY-MM`. Local on purpose: not UTC's month. */
export function monthOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function isMonthKey(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}$/.test(value);
}
