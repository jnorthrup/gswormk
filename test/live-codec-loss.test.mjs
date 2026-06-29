import test from 'node:test';
import assert from 'node:assert/strict';
import { PaperBroker } from '../src/trader/paper-broker.ts';

test('PaperBroker: validate_only guess orders do not lock assets and compute virtualPnL', () => {
  const broker = new PaperBroker({ initialCash: 10000 });
  
  // Post BUY guess order for BTC-USD at limit price 60000
  const postResult = broker.postOrder({
    product_id: 'BTC-USD',
    side: 'BUY',
    validate_only: true,
    timestamp: '2026-06-27T12:00:00Z',
    order_configuration: {
      limit_limit_gtc: {
        base_size: '0.1',
        limit_price: '60000',
      }
    }
  });

  assert.ok(postResult.accepted);
  // Confirm no cash is locked
  assert.strictEqual(broker.lockedCash, 0);

  // Update pending orders with price = 61000.
  // Because it is a guess and GTC, it should stay pending and compute virtual PnL:
  // virtualPnL = (61000 - 60000) * 0.1 = 100
  broker.updatePendingOrders({ 'BTC-USD': 61000 }, '2026-06-27T12:01:00Z');

  const metrics = broker.getCodecMetrics();
  assert.strictEqual(metrics.guessCount, 1);
  assert.strictEqual(metrics.totalVirtualPnL, 100);
});

test('PaperBroker: limit orders lock assets and fill when threshold met', () => {
  const broker = new PaperBroker({ initialCash: 10000 });

  // Post actual limit BUY order
  const postResult = broker.postOrder({
    product_id: 'BTC-USD',
    side: 'BUY',
    validate_only: false,
    timestamp: '2026-06-27T12:00:00Z',
    order_configuration: {
      limit_limit_gtc: {
        base_size: '0.1',
        limit_price: '60000',
      }
    }
  });

  assert.ok(postResult.accepted);
  // Confirm cash is locked: 60000 * 0.1 = 6000
  assert.strictEqual(broker.lockedCash, 6000);

  // Update price to 60100 (does not fill BUY limit order at 60000)
  const fills1 = broker.updatePendingOrders({ 'BTC-USD': 60100 }, '2026-06-27T12:01:00Z');
  assert.strictEqual(fills1.length, 0);
  assert.strictEqual(broker.cash, 10000);

  // Update price to 59900 (meets threshold, should fill)
  const fills2 = broker.updatePendingOrders({ 'BTC-USD': 59900 }, '2026-06-27T12:02:00Z');
  assert.strictEqual(fills2.length, 1);
  assert.strictEqual(fills2[0].accepted, true);
  // Cash should be deducted by limit price (6000) and cash lock released
  assert.strictEqual(broker.cash, 4000);
  assert.strictEqual(broker.lockedCash, 0);
  assert.strictEqual(broker.getUnits('BTC-USD'), 0.1);
});

test('PaperBroker: GTD limit orders expire and unlock assets', () => {
  const broker = new PaperBroker({ initialCash: 10000 });

  // Post actual limit BUY order expiring at 12:05:00
  const postResult = broker.postOrder({
    product_id: 'BTC-USD',
    side: 'BUY',
    validate_only: false,
    timestamp: '2026-06-27T12:00:00Z',
    order_configuration: {
      limit_limit_gtd: {
        base_size: '0.1',
        limit_price: '60000',
        end_time: '2026-06-27T12:05:00Z',
      }
    }
  });

  assert.ok(postResult.accepted);
  assert.strictEqual(broker.lockedCash, 6000);

  // Update price to 60100 at 12:04:00 (not expired yet)
  broker.updatePendingOrders({ 'BTC-USD': 60100 }, '2026-06-27T12:04:00Z');
  assert.strictEqual(broker.lockedCash, 6000);
  assert.strictEqual(broker.pendingOrders.length, 1);

  // Update price to 60100 at 12:05:00 (expired)
  broker.updatePendingOrders({ 'BTC-USD': 60100 }, '2026-06-27T12:05:00Z');
  assert.strictEqual(broker.lockedCash, 0);
  assert.strictEqual(broker.pendingOrders.length, 0);
  
  const metrics = broker.getCodecMetrics();
  assert.strictEqual(metrics.expiredLimitCount, 1);
});
