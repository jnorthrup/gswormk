export class PaperBroker {
  constructor({ initialCash }) {
    this.cash = initialCash;
    this.positions = new Map();
    this.avgEntry = new Map();
    this.orders = [];
  }

  getUnits(symbol) {
    return this.positions.get(symbol) ?? 0;
  }

  getPositionValue(symbol, price) {
    return this.getUnits(symbol) * price;
  }

  getNav(prices) {
    let nav = this.cash;
    for (const [symbol, units] of this.positions.entries()) {
      nav += units * (prices[symbol] ?? 0);
    }
    return nav;
  }

  getPortfolio(prices) {
    const nav = this.getNav(prices);
    const positions = Object.fromEntries([...this.positions.entries()].map(([symbol, units]) => [
      symbol,
      {
        units,
        price: prices[symbol] ?? 0,
        marketValue: units * (prices[symbol] ?? 0),
      },
    ]));
    return { cash: this.cash, nav, positions };
  }

  execute({ symbol, side, quantity, price, timestamp }) {
    const gross = quantity * price;
    const signedQuantity = side === 'BUY' ? quantity : -quantity;
    const currentUnits = this.getUnits(symbol);
    const nextUnits = currentUnits + signedQuantity;

    if (side === 'BUY' && gross > this.cash) {
      return { accepted: false, reason: 'INSUFFICIENT_CASH' };
    }

    if (side === 'SELL' && quantity > currentUnits) {
      return { accepted: false, reason: 'INSUFFICIENT_UNITS' };
    }

    this.cash += side === 'BUY' ? -gross : gross;
    this.positions.set(symbol, nextUnits);

    const previousAvg = this.avgEntry.get(symbol) ?? price;
    const nextAvg = side === 'BUY' && nextUnits > 0
      ? (((currentUnits * previousAvg) + gross) / nextUnits)
      : previousAvg;
    this.avgEntry.set(symbol, nextAvg);

    const fill = {
      accepted: true,
      timestamp,
      symbol,
      side,
      quantity,
      price,
      gross,
      remainingCash: this.cash,
      remainingUnits: nextUnits,
    };
    this.orders.push(fill);
    return fill;
  }
}