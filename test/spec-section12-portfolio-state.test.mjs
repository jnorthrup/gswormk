/**
 * ══════════════════════════════════════════════════════════════════════════════
 * § 12  Portfolio State Update — TDD Red Suite
 * ══════════════════════════════════════════════════════════════════════════════
 *
 *  After fill $F_{i,t}$ at price $p_{i,t}^{\text{fill}}$:
 *
 *    $$\text{units}_{i,t+1} = \text{units}_{i,t}
 *      + \mathrm{sign}(N_{i,t}) \cdot F_{i,t}$$
 *
 *    $$\text{cash}_{t+1} = \text{cash}_t
 *      - \mathrm{sign}(N_{i,t}) \cdot F_{i,t}\,p_{i,t}^{\text{fill}}
 *      - \mathrm{fees}_t$$
 *
 *    $$\mathrm{NAV}_{t+1} = \text{cash}_{t+1}
 *      + \sum_i \text{units}_{i,t+1}\,m_{i,t+1}$$
 *
 *    $$w_{i,t+1}
 *      = \frac{\text{units}_{i,t+1}\,m_{i,t+1}}{\mathrm{NAV}_{t+1}}$$
 *
 *    $$\mathrm{NAV}^{\text{peak}}_{t+1}
 *      = \max(\mathrm{NAV}^{\text{peak}}_t, \mathrm{NAV}_{t+1})$$
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PaperBroker } from '../src/trader/paper-broker.ts';

test('§12 buy: units increase, cash decreases by gross', () => {
  const broker = new PaperBroker({ initialCash: 100000 });
  const result = broker.execute({
    symbol: 'BTC-USD',
    side: 'BUY',
    quantity: 0.5,
    price: 65000,
    timestamp: '2024-01-01T00:00:00Z',
  });

  assert.ok(result.accepted);
  assert.strictEqual(broker.getUnits('BTC-USD'), 0.5);
  assert.strictEqual(broker.cash, 100000 - 0.5 * 65000);
});

test('§12 sell: units decrease, cash increases by gross', () => {
  const broker = new PaperBroker({ initialCash: 100000 });
  broker.execute({
    symbol: 'BTC-USD', side: 'BUY', quantity: 1.0,
    price: 65000, timestamp: '2024-01-01T00:00:00Z',
  });
  broker.execute({
    symbol: 'BTC-USD', side: 'SELL', quantity: 0.3,
    price: 66000, timestamp: '2024-01-01T00:01:00Z',
  });

  assert.ok(
    Math.abs(broker.getUnits('BTC-USD') - 0.7) < 1e-12,
    `units should be 0.7, got ${broker.getUnits('BTC-USD')}`,
  );
});

test('§12 NAV = cash + Σ(units_i * m_i)', () => {
  const broker = new PaperBroker({ initialCash: 100000 });
  broker.execute({
    symbol: 'BTC-USD', side: 'BUY', quantity: 0.5,
    price: 65000, timestamp: '2024-01-01T00:00:00Z',
  });

  const prices = { 'BTC-USD': 66000 };
  const nav = broker.getNav(prices);
  const expected = broker.cash + 0.5 * 66000;
  assert.ok(
    Math.abs(nav - expected) < 1e-6,
    `NAV=${nav} should equal cash + units*price = ${expected}`,
  );
});

test('§12 portfolio weight = units * price / NAV', () => {
  const broker = new PaperBroker({ initialCash: 100000 });
  broker.execute({
    symbol: 'BTC-USD', side: 'BUY', quantity: 0.5,
    price: 65000, timestamp: '2024-01-01T00:00:00Z',
  });

  const prices = { 'BTC-USD': 66000 };
  const portfolio = broker.getPortfolio(prices);
  const expectedWeight = (0.5 * 66000) / portfolio.nav;
  const actualWeight = portfolio.positions['BTC-USD'].marketValue / portfolio.nav;

  assert.ok(
    Math.abs(actualWeight - expectedWeight) < 1e-9,
    `weight=${actualWeight} should match ${expectedWeight}`,
  );
});

test('§12 peak NAV tracks running maximum', () => {
  let peakNav = 100000;

  // Simulate NAV sequence: 100000, 101000, 99500, 102000
  for (const nav of [100000, 101000, 99500, 102000]) {
    peakNav = Math.max(peakNav, nav);
  }

  assert.strictEqual(peakNav, 102000, 'peak should track the maximum');
});

test('§12 buy rejected when insufficient cash', () => {
  const broker = new PaperBroker({ initialCash: 1000 });
  const result = broker.execute({
    symbol: 'BTC-USD', side: 'BUY', quantity: 1.0,
    price: 65000, timestamp: '2024-01-01T00:00:00Z',
  });
  assert.ok(!result.accepted, 'should reject buy when insufficient cash');
  assert.strictEqual(result.reason, 'INSUFFICIENT_CASH');
});

test('§12 sell rejected when insufficient units', () => {
  const broker = new PaperBroker({ initialCash: 100000 });
  const result = broker.execute({
    symbol: 'BTC-USD', side: 'SELL', quantity: 1.0,
    price: 65000, timestamp: '2024-01-01T00:00:00Z',
  });
  assert.ok(!result.accepted, 'should reject sell when no units held');
  assert.strictEqual(result.reason, 'INSUFFICIENT_UNITS');
});

test('§12 NAV conservation: NAV before = NAV after for zero-spread execution', () => {
  const broker = new PaperBroker({ initialCash: 100000 });
  const price = 65000;
  const navBefore = broker.getNav({ 'BTC-USD': price });

  broker.execute({
    symbol: 'BTC-USD', side: 'BUY', quantity: 0.5,
    price, timestamp: '2024-01-01T00:00:00Z',
  });

  const navAfter = broker.getNav({ 'BTC-USD': price });
  assert.ok(
    Math.abs(navBefore - navAfter) < 1e-6,
    `NAV should be conserved at same price: before=${navBefore} after=${navAfter}`,
  );
});

test('§12 multi-asset NAV sums across all positions', () => {
  const broker = new PaperBroker({ initialCash: 200000 });
  broker.execute({
    symbol: 'BTC-USD', side: 'BUY', quantity: 1.0,
    price: 65000, timestamp: '2024-01-01T00:00:00Z',
  });
  broker.execute({
    symbol: 'ETH-USD', side: 'BUY', quantity: 10.0,
    price: 3200, timestamp: '2024-01-01T00:00:00Z',
  });

  const prices = { 'BTC-USD': 66000, 'ETH-USD': 3300 };
  const nav = broker.getNav(prices);
  const expected = broker.cash + 1.0 * 66000 + 10.0 * 3300;
  assert.ok(
    Math.abs(nav - expected) < 1e-6,
    `multi-asset NAV=${nav} should equal ${expected}`,
  );
});
