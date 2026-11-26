import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

interface CodexRateLimitWindow {
  readonly usedPercent: number;
  readonly resetsAt?: number | null;
  readonly windowDurationMins?: number | null;
}

export interface CodexRateLimitSnapshot {
  readonly limitId?: string | null;
  readonly planType?: string | null;
  readonly rateLimitReachedType?: string | null;
  readonly primary?: CodexRateLimitWindow | null;
  readonly secondary?: CodexRateLimitWindow | null;
  readonly individualLimit?: {
    readonly remainingPercent: number;
    readonly resetsAt: number;
  } | null;
}

function isoFromEpochSeconds(value: number | null | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const dt = DateTime.make(value * 1000);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

/** Rate-limit notifications are partial: omitted fields preserve earlier session values. */
export function mergeCodexRateLimits(
  previous: CodexRateLimitSnapshot | undefined,
  update: CodexRateLimitSnapshot,
): CodexRateLimitSnapshot | undefined {
  // Model-specific snapshots must not overwrite the main allowance.
  if (update.limitId && update.limitId !== "codex") return previous;
  if (!previous) return update;
  return {
    ...previous,
    ...(update.limitId !== undefined ? { limitId: update.limitId } : {}),
    ...(update.planType !== undefined ? { planType: update.planType } : {}),
    ...(update.rateLimitReachedType !== undefined
      ? { rateLimitReachedType: update.rateLimitReachedType }
      : {}),
    ...(update.primary !== undefined ? { primary: update.primary } : {}),
    ...(update.secondary !== undefined ? { secondary: update.secondary } : {}),
    ...(update.individualLimit !== undefined ? { individualLimit: update.individualLimit } : {}),
  };
}

function exhaustedResetTimestamps(
  snapshot: CodexRateLimitSnapshot,
): ReadonlyArray<string | undefined> {
  if (snapshot.limitId && snapshot.limitId !== "codex") return [];
  const timestamps: Array<string | undefined> = [];
  for (const window of [snapshot.primary, snapshot.secondary]) {
    if (window && Number.isFinite(window.usedPercent) && window.usedPercent >= 100) {
      timestamps.push(isoFromEpochSeconds(window.resetsAt));
    }
  }
  const individualLimit = snapshot.individualLimit;
  if (
    individualLimit &&
    Number.isFinite(individualLimit.remainingPercent) &&
    100 - individualLimit.remainingPercent >= 100
  ) {
    timestamps.push(isoFromEpochSeconds(individualLimit.resetsAt));
  }
  return timestamps;
}

/** All exhausted windows must reset before a continuation can run. */
export function codexUsageLimitResetAt(
  snapshot: CodexRateLimitSnapshot | undefined,
): string | null {
  if (!snapshot) return null;
  const resets = exhaustedResetTimestamps(snapshot);
  if (resets.length === 0 || resets.some((reset) => !reset)) return null;
  return resets.reduce<string | null>(
    (latest, reset) =>
      latest === null || Date.parse(reset!) > Date.parse(latest) ? reset! : latest,
    null,
  );
}

const CODEX_RESET_TEXT =
  /[Tt]ry again at (?:([A-Z][a-z]{2}) (\d{1,2})(?:st|nd|rd|th), (\d{4}) )?(\d{1,2}):(\d{2}) ([AP]M)\./;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The zone Codex prints reset times in: its own `TZ`, else the server's. */
export function codexTimeZone(
  environment: Readonly<Record<string, string | undefined>>,
): DateTime.TimeZone {
  return Option.getOrElse(
    DateTime.zoneMakeNamed(environment.TZ?.replace(/^:/, "") ?? ""),
    DateTime.zoneMakeLocal,
  );
}

/**
 * Codex writes a usage limit's reset into its error text in its own local time:
 * "Try again at 3:37 PM." for today, else "try again at Nov 11th, 2026 3:37 PM.".
 * It is the only reset left when a proxy such as CLIProxyAPI strips the rate-limit snapshot.
 * `failedAt` is when Codex reported the failure, which fixes the date of today's form.
 */
export function codexMessageResetAt(
  message: string,
  failedAt: DateTime.DateTime,
  zone: DateTime.TimeZone,
): string | null {
  const match = CODEX_RESET_TEXT.exec(message);
  if (!match) return null;
  const [, month, day, year, hour, minute, meridiem] = match;
  const monthIndex = month === undefined ? undefined : MONTHS.indexOf(month);
  if (monthIndex === -1) return null;
  const today = DateTime.toParts(DateTime.setZone(failedAt, zone));
  const reset = DateTime.makeZoned(
    {
      year: monthIndex === undefined ? today.year : Number(year),
      month: monthIndex === undefined ? today.month : monthIndex + 1,
      day: monthIndex === undefined ? today.day : Number(day),
      hour: (Number(hour) % 12) + (meridiem === "PM" ? 12 : 0),
      minute: Number(minute),
    },
    // The repeated hour at a DST fall-back takes its later instant so a resume never fires early.
    { timeZone: zone, adjustForTimeZone: true, disambiguation: "later" },
  );
  if (Option.isNone(reset)) return null;
  // Codex drops the seconds, so the next minute is the first one past the reset.
  const resetAt = DateTime.add(reset.value, { minutes: 1 });
  return DateTime.isGreaterThan(resetAt, failedAt) ? DateTime.formatIso(resetAt) : null;
}
