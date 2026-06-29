// L2: Signal Orthogonality Audit (TODO item 4)
// Rolling pairwise correlation matrix, flag |ρ| > threshold, residualize redundant signals.

import { EPSILON } from '../lib/math.ts';

export type SignalSnapshot = Record<string, number>;

export type CorrelationRecord = {
  pair: string;
  rho: number;
};

export type OrthogonalityReport = {
  correlations: CorrelationRecord[];
  redundantPairs: CorrelationRecord[];
  sampleCount: number;
};

export type ResidualizeInput = {
  target: string;
  against: string;
};

export type ResidualizeResult = {
  beta: number;
  residuals: number[];
};

/**
 * Pearson correlation coefficient. Returns null for:
 *   - mismatched lengths
 *   - constant series (zero variance → undefined)
 */
export function pearsonCorrelation(a: readonly number[], b: readonly number[]): number | null {
  if (!a || !b || a.length !== b.length || a.length < 2) return null;
  const n = a.length;
  const meanA = a.reduce((sum, x) => sum + x, 0) / n;
  const meanB = b.reduce((sum, x) => sum + x, 0) / n;
  let numerator = 0;
  let denominatorA = 0;
  let denominatorB = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[i]! - meanA;
    const db = b[i]! - meanB;
    numerator += da * db;
    denominatorA += da * da;
    denominatorB += db * db;
  }
  if (denominatorA < EPSILON || denominatorB < EPSILON) return null;
  return numerator / Math.sqrt(denominatorA * denominatorB);
}

function pairName(x: string, y: string): string {
  return [x, y].sort().join('-');
}

export class OrthogonalityAudit {
  private readonly windowSize: number;
  private readonly redundancyThreshold: number;
  private readonly buffer: SignalSnapshot[] = [];

  constructor({ windowSize = 200, redundancyThreshold = 0.7 }: { windowSize?: number; redundancyThreshold?: number } = {}) {
    this.windowSize = windowSize;
    this.redundancyThreshold = redundancyThreshold;
  }

  record(snapshot: SignalSnapshot): void {
    this.buffer.push(snapshot);
    if (this.buffer.length > this.windowSize) this.buffer.shift();
  }

  private fields(): string[] {
    const set = new Set<string>();
    for (const snapshot of this.buffer) {
      for (const key of Object.keys(snapshot)) set.add(key);
    }
    return [...set];
  }

  private series(field: string): number[] {
    return this.buffer.map((snapshot) => Number(snapshot[field])).filter((value) => Number.isFinite(value));
  }

  // Compatibility with the pre-TypeScript module and existing tests.
  _series(field: string): number[] {
    return this.series(field);
  }

  report(): OrthogonalityReport {
    const fields = this.fields();
    const correlations: CorrelationRecord[] = [];
    for (let i = 0; i < fields.length; i += 1) {
      for (let j = i + 1; j < fields.length; j += 1) {
        const left = fields[i]!;
        const right = fields[j]!;
        const a = this.series(left);
        const b = this.series(right);
        const rho = pearsonCorrelation(a, b);
        if (rho !== null) {
          correlations.push({ pair: pairName(left, right), rho });
        }
      }
    }
    const redundantPairs = correlations.filter((correlation) => Math.abs(correlation.rho) > this.redundancyThreshold);
    return { correlations, redundantPairs, sampleCount: this.buffer.length };
  }

  /**
   * Ordinary least squares residualization: removes linear dependence of
   * `target` on `against`. Returns { beta, residuals }.
   * residual[i] = target[i] - beta * against[i]
   */
  residualize({ target, against }: ResidualizeInput): ResidualizeResult {
    const t = this.series(target);
    const a = this.series(against);
    const n = Math.min(t.length, a.length);
    if (n < 2) return { beta: 0, residuals: [] };
    const tSlice = t.slice(-n);
    const aSlice = a.slice(-n);
    const meanT = tSlice.reduce((sum, x) => sum + x, 0) / n;
    const meanA = aSlice.reduce((sum, x) => sum + x, 0) / n;
    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < n; i += 1) {
      numerator += (aSlice[i]! - meanA) * (tSlice[i]! - meanT);
      denominator += (aSlice[i]! - meanA) ** 2;
    }
    const beta = denominator > EPSILON ? numerator / denominator : 0;
    const residuals = tSlice.map((value, index) => value - beta * aSlice[index]!);
    return { beta, residuals };
  }
}
