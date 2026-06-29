// L2: Confidence Calibration (TODO item 5)
// rawAdvantageProbability → calibratedAdvantageProbability
// Accumulates closed-trade outcomes, bins by raw decile, fits isotonic map.
// Gate: competence requires calibration error <= threshold across populated bins.

export type IsotonicPoint = {
  x: number;
  y: number;
};

type IsotonicBlock = {
  sumY: number;
  weight: number;
  xMin: number;
  xMax: number;
};

export type CalibrationRecord = {
  rawProbability: number;
  won: boolean;
};

export type CalibrationBin = {
  label: string;
  count: number;
  wins: number;
  hitRate: number;
};

export type CalibrationReport = {
  bins: CalibrationBin[];
  calibrationError: number;
  competent: boolean;
  sampleCount: number;
};

export type CalibrationTrackerOptions = {
  minSamplesForFit?: number;
  competenceErrorThreshold?: number;
  rollingWindowSize?: number;
};

/**
 * Pool Adjacent Violators Algorithm (PAVA) for isotonic regression.
 * Given points sorted by x, returns a monotonic (non-decreasing) y mapping.
 */
export function isotonicFit(points: readonly IsotonicPoint[]): (x: number) => number {
  if (!points || points.length === 0) {
    return (x: number) => x;
  }

  // PAVA: produce blocks with pooled y (weighted by count) and block boundaries.
  const blocks: IsotonicBlock[] = [];
  for (const point of points) {
    const last = blocks.at(-1);
    if (last && point.y < last.sumY / last.weight) {
      // violation: merge backward until monotonic
      last.sumY += point.y;
      last.weight += 1;
      last.xMax = point.x;
      while (blocks.length >= 2) {
        const previous = blocks[blocks.length - 2]!;
        const current = blocks[blocks.length - 1]!;
        if (previous.sumY / previous.weight > current.sumY / current.weight) {
          previous.sumY += current.sumY;
          previous.weight += current.weight;
          previous.xMax = current.xMax;
          blocks.pop();
        } else break;
      }
    } else {
      blocks.push({ sumY: point.y, weight: 1, xMin: point.x, xMax: point.x });
    }
  }

  const xs = points.map((point) => point.x);
  const min = Math.min(...xs);
  const max = Math.max(...xs);

  return function fit(x: number): number {
    const first = blocks[0]!;
    const last = blocks[blocks.length - 1]!;
    if (x <= min) return first.sumY / first.weight;
    if (x >= max) return last.sumY / last.weight;
    for (const block of blocks) {
      if (x >= block.xMin && x <= block.xMax) return block.sumY / block.weight;
      if (x < block.xMin) {
        // interpolate between previous block and this one
        const index = blocks.indexOf(block);
        if (index === 0) return block.sumY / block.weight;
        const previous = blocks[index - 1]!;
        const previousY = previous.sumY / previous.weight;
        const currentY = block.sumY / block.weight;
        const t = (x - previous.xMax) / (block.xMin - previous.xMax || 1);
        return previousY + (currentY - previousY) * t;
      }
    }
    return last.sumY / last.weight;
  };
}

const DECILE_EDGES = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0] as const;

function decileLabel(p: number): string {
  for (let i = 0; i < DECILE_EDGES.length - 1; i += 1) {
    const lo = DECILE_EDGES[i]!;
    const hi = DECILE_EDGES[i + 1]!;
    if (p >= lo && p < hi) {
      return `${lo.toFixed(1)}-${hi.toFixed(1)}`;
    }
  }
  return '0.9-1.0';
}

export class CalibrationTracker {
  private readonly minSamplesForFit: number;
  private readonly competenceErrorThreshold: number;
  private readonly rollingWindowSize: number;
  private readonly records: CalibrationRecord[] = [];
  private fit: ((x: number) => number) | null = null;

  constructor({
    minSamplesForFit = 30,
    competenceErrorThreshold = 0.05,
    rollingWindowSize = 500,
  }: CalibrationTrackerOptions = {}) {
    this.minSamplesForFit = minSamplesForFit;
    this.competenceErrorThreshold = competenceErrorThreshold;
    this.rollingWindowSize = rollingWindowSize;
  }

  record({ rawProbability, won }: CalibrationRecord): void {
    this.records.push({ rawProbability, won: Boolean(won) });
    if (this.records.length > this.rollingWindowSize) {
      this.records.shift();
    }
  }

  private bins(): CalibrationBin[] {
    const byLabel = new Map<string, { label: string; wins: number; count: number }>();
    for (const record of this.records) {
      const label = decileLabel(record.rawProbability);
      if (!byLabel.has(label)) byLabel.set(label, { label, wins: 0, count: 0 });
      const bin = byLabel.get(label)!;
      bin.count += 1;
      if (record.won) bin.wins += 1;
    }
    return [...byLabel.values()].map((bin) => ({
      label: bin.label,
      count: bin.count,
      wins: bin.wins,
      hitRate: bin.count > 0 ? bin.wins / bin.count : 0,
    }));
  }

  private decileMidpoints(): number[] {
    return DECILE_EDGES.slice(0, -1).map((lo, index) => (lo + DECILE_EDGES[index + 1]!) / 2);
  }

  report(): CalibrationReport {
    const bins = this.bins();
    // Map midpoint → realized hit rate for populated bins only.
    const midpoints = this.decileMidpoints();
    let absErrSum = 0;
    let absErrCount = 0;
    for (const bin of bins) {
      const index = DECILE_EDGES.findIndex((lo, i) =>
        i < DECILE_EDGES.length - 1 && bin.label === `${lo.toFixed(1)}-${DECILE_EDGES[i + 1]!.toFixed(1)}`);
      const midpoint = midpoints[index] ?? 0.5;
      absErrSum += Math.abs(bin.hitRate - midpoint);
      absErrCount += 1;
    }
    const calibrationError = absErrCount > 0 ? absErrSum / absErrCount : 0;
    const competent = calibrationError <= this.competenceErrorThreshold;
    return { bins, calibrationError, competent, sampleCount: this.records.length };
  }

  refit(): void {
    if (this.records.length < this.minSamplesForFit) {
      this.fit = null;
      return;
    }
    const report = this.report();
    const midpoints = this.decileMidpoints();
    const sorted = report.bins
      .map((bin) => {
        const index = DECILE_EDGES.findIndex((lo, i) =>
          i < DECILE_EDGES.length - 1 && bin.label === `${lo.toFixed(1)}-${DECILE_EDGES[i + 1]!.toFixed(1)}`);
        return { x: midpoints[index] ?? 0.5, y: bin.hitRate };
      })
      .sort((left, right) => left.x - right.x);
    this.fit = isotonicFit(sorted);
  }

  calibrate(rawProbability: number): number {
    if (!this.fit) return rawProbability;
    return this.fit(rawProbability);
  }
}
