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

export class DetClock {
  private seq = 0;

  /** The next timestamp: epoch + 1, 2, 3, ... seconds. */
  next(): DetTimestamp {
    this.seq += 1;
    const epochSec = SCENARIO_EPOCH_SEC + this.seq;
    return { epochSec, iso: new Date(epochSec * 1000).toISOString() };
  }
}
