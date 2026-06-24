export const EPSILON = 1e-12;

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function variance(values) {
  if (values.length === 0) return 0;
  const avg = mean(values);
  return values.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / values.length;
}

export function downsideSemivariance(values) {
  if (values.length === 0) return 0;
  const avg = mean(values);
  return values.reduce((sum, value) => sum + (Math.min(0, value - avg) ** 2), 0) / values.length;
}

export function logistic(x) {
  return 1 / (1 + Math.exp(-x));
}

export function quantile(sortedValues, q) {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.floor(q * sortedValues.length)));
  return sortedValues[index];
}

export function sum(values) {
  return values.reduce((accumulator, value) => accumulator + value, 0);
}

export function safeDivide(a, b, fallback = 0) {
  return Math.abs(b) < EPSILON ? fallback : a / b;
}

export function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}