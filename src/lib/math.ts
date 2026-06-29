export const EPSILON = 1e-12;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function variance(values: readonly number[]): number {
  if (values.length <= 1) return 0;
  const avg = mean(values);
  return values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
}

export function downsideSemivariance(values: readonly number[]): number {
  if (values.length <= 1) return 1e-9;
  const result = values.reduce((sum, value) => sum + Math.min(0, value) ** 2, 0) / (values.length - 1);
  return Math.max(result, 1e-9);
}

export function logistic(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export function quantile(sortedValues: readonly number[], q: number): number {
  if (sortedValues.length === 0) return 0;
  // Standard linear interpolation: index = q * (n - 1)
  const n = sortedValues.length;
  const index = q * (n - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  if (lower === upper) return sortedValues[lower]!;
  return sortedValues[lower]! * (1 - weight) + sortedValues[upper]! * weight;
}

export function sum(values: readonly number[]): number {
  return values.reduce((accumulator, value) => accumulator + value, 0);
}

export function safeDivide(a: number, b: number, fallback = 0): number {
  return Math.abs(b) < EPSILON ? fallback : a / b;
}

export function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
