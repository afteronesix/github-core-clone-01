// A deterministic clock: every server-created timestamp is a fixed epoch plus a
// monotonic counter. Two runs that issue the same requests in the same order get the
// same timestamps, so no wall clock ever reaches a response. (No Date.now() anywhere
// in a response path — see the determinism plan.)

import { SCENARIO_EPOCH_SEC } from './scenario.ts';

/** One timestamp: unix seconds plus its ISO-8601 rendering. */
export interface DetTimestamp {
  readonly epochSec: number;
  readonly iso: string;
}

/** Two-digit strings 00..99, so formatting never calls padStart. */
const PAD2: readonly string[] = Array.from({ length: 100 }, (_, i) => (i < 10 ? `0${i}` : `${i}`));

/**
 * Format unix seconds as an ISO-8601 UTC string (`YYYY-MM-DDTHH:MM:SS.000Z`)
 * with pure integer math (Howard Hinnant's civil-from-days algorithm) —
 * byte-identical to `new Date(sec * 1000).toISOString()` for whole seconds,
 * without allocating a Date. Verified against Date for 200k consecutive
 * seconds from the scenario epoch plus leap-day and year boundaries.
 */
export function formatIsoUtc(epochSec: number): string {
  const days = Math.floor(epochSec / 86400);
  const secsOfDay = epochSec - days * 86400;
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  let year = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  if (month <= 2) year += 1;
  const hour = Math.floor(secsOfDay / 3600);
  const minute = Math.floor((secsOfDay - hour * 3600) / 60);
  const second = secsOfDay - hour * 3600 - minute * 60;
  const yearStr = year >= 1000 && year <= 9999 ? String(year) : String(year).padStart(4, '0');
  return `${yearStr}-${PAD2[month] as string}-${PAD2[day] as string}T${PAD2[hour] as string}:${PAD2[minute] as string}:${PAD2[second] as string}.000Z`;
}

export class DetClock {
  private seq = 0;

  /** The next timestamp: epoch + 1, 2, 3, ... seconds. */
  next(): DetTimestamp {
    this.seq += 1;
    const epochSec = SCENARIO_EPOCH_SEC + this.seq;
    return { epochSec, iso: formatIsoUtc(epochSec) };
  }
}
