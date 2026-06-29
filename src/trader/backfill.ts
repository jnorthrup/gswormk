// L5: Historical Backfill (per TODO build order item 3)
// Pure functions for date range and chunked-window planning.

import { MS, granularityMinutes } from '../lib/time.ts';

export type BackfillRange = {
  startMs: number;
  endMs: number;
  startIso: string;
  endIso: string;
};

export type ComputeBackfillDateRangeInput = {
  days: number;
  referenceMs?: number;
};

export type PlanBackfillWindowsInput = {
  range: BackfillRange;
  chunkHours?: number;
};

export type EstimateCandleCountInput = {
  granularity: string;
  hours: number;
};

/**
 * Returns minute-aligned date range in ms and ISO strings.
 * End is rounded DOWN to top of minute to match candle starts.
 */
export function computeBackfillDateRange({ days, referenceMs = Date.now() }: ComputeBackfillDateRangeInput): BackfillRange {
  if (days <= 0) {
    throw new Error('days must be > 0');
  }

  // Round reference DOWN to top of minute for endMs
  const alignedEnd = Math.floor(referenceMs / MS.MINUTE) * MS.MINUTE;

  const startMs = Math.floor((alignedEnd - (days * MS.DAY)) / MS.MINUTE) * MS.MINUTE;
  const endMs = alignedEnd;

  return {
    startMs,
    endMs,
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
  };
}

/**
 * Splits a backfill range into windows of `chunkHours`.
 * Windows start at the end of the previous one (no gaps, no overlaps).
 */
export function planBackfillWindows({ range, chunkHours = 24 }: PlanBackfillWindowsInput): BackfillRange[] {
  if (chunkHours <= 0) {
    throw new Error('chunkHours must be > 0');
  }

  const chunkMs = chunkHours * MS.HOUR;
  const windows: BackfillRange[] = [];
  let cursor = range.startMs;
  const end = range.endMs;

  while (cursor < end) {
    const next = Math.min(cursor + chunkMs, end);
    windows.push({
      startMs: cursor,
      endMs: next,
      startIso: new Date(cursor).toISOString(),
      endIso: new Date(next).toISOString(),
    });
    cursor = next;
  }

  return windows;
}

/**
 * Estimates the number of candles returned for a given granularity and hour-window.
 */
export function estimateCandleCount({ granularity, hours }: EstimateCandleCountInput): number {
  const minutesPerCandle = granularityMinutes(granularity);
  const minutes = hours * 60;
  return Math.floor(minutes / minutesPerCandle);
}
