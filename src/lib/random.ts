export class SeededRandom {
  private state: number;

  constructor(seed = 42) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (1_664_525 * this.state + 1_013_904_223) >>> 0;
    return this.state / 0x1_0000_0000;
  }

  normal(mean = 0, standardDeviation = 1): number {
    const u1 = Math.max(this.next(), 1e-12);
    const u2 = this.next();
    const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return mean + (z0 * standardDeviation);
  }
}
