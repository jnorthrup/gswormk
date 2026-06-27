import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export class PaperBroker {
  constructor({ initialCash, persistPath = null }) {
    this.cash = initialCash;
    this.positions = new Map();
    this.avgEntry = new Map();
    this.orders = [];
    this.pendingOrders = [];
    this.lockedCash = 0;
    this.lockedUnits = new Map();
    this.persistPath = persistPath;

    if (this.persistPath) {
      this.loadState();
    }
  }

  loadState() {
    try {
      if (existsSync(this.persistPath)) {
        const raw = readFileSync(this.persistPath, 'utf8');
        const data = JSON.parse(raw);
        this.cash = data.cash ?? this.cash;
        this.positions = new Map(Object.entries(data.positions || {}));
        this.avgEntry = new Map(Object.entries(data.avgEntry || {}));
        this.orders = data.orders || [];
        this.pendingOrders = data.pendingOrders || [];
        this.lockedCash = data.lockedCash || 0;
        this.lockedUnits = new Map(Object.entries(data.lockedUnits || {}));
        console.log(`[Broker] Restored state from ${this.persistPath}. Cash: $${this.cash.toFixed(2)}, Positions:`, Object.fromEntries(this.positions));
      }
    } catch (error) {
      console.error(`[Broker] Failed to load paper wallet state:`, error);
    }
  }

  saveState() {
    if (!this.persistPath) return;
    try {
      const data = {
        cash: this.cash,
        positions: Object.fromEntries(this.positions),
        avgEntry: Object.fromEntries(this.avgEntry),
        orders: this.orders,
        pendingOrders: this.pendingOrders,
        lockedCash: this.lockedCash,
        lockedUnits: Object.fromEntries(this.lockedUnits),
      };
      writeFileSync(this.persistPath, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
      console.error(`[Broker] Failed to save paper wallet state:`, error);
    }
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
    this.saveState();
    return fill;
  }

  postOrder({ client_order_id, product_id, side, order_configuration, validate_only = false, timestamp, link_id }) {
    const isLimit = order_configuration?.limit_limit_gtd || order_configuration?.limit_limit_gtc;
    if (!isLimit) {
      return { accepted: false, reason: 'INVALID_ORDER_CONFIGURATION' };
    }

    const config = order_configuration.limit_limit_gtd || order_configuration.limit_limit_gtc;
    const limitPrice = Number(Number(config.limit_price).toFixed(2));
    const quantity = Number(config.base_size);
    const gross = quantity * limitPrice;
    const orderId = client_order_id || `order_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;

    if (!validate_only) {
      if (side === 'BUY') {
        const availableCash = this.cash - this.lockedCash;
        if (gross > availableCash) {
          return { accepted: false, reason: 'INSUFFICIENT_CASH', order_id: orderId };
        }
        this.lockedCash += gross;
      } else {
        // If it is part of OCO, check if shared lock is already active
        const sharedLocked = link_id && this.pendingOrders.some((o) => o.link_id === link_id && o.status === 'PENDING');
        if (!sharedLocked) {
          const currentUnits = this.getUnits(product_id);
          const locked = this.lockedUnits.get(product_id) ?? 0;
          const availableUnits = currentUnits - locked;
          if (quantity > availableUnits) {
            return { accepted: false, reason: 'INSUFFICIENT_UNITS', order_id: orderId };
          }
          this.lockedUnits.set(product_id, locked + quantity);
        }
      }
    }

    const order = {
      order_id: orderId,
      product_id,
      side,
      price: limitPrice,
      quantity,
      order_configuration,
      validate_only,
      status: 'PENDING',
      timestamp,
      virtualPnL: 0,
      initialPrice: limitPrice,
      link_id,
    };

    this.pendingOrders.push(order);
    this.saveState();
    return { accepted: true, order_id: orderId, order };
  }

  updatePendingOrders(prices, timestamp) {
    const filledOrders = [];
    const activePending = [];
    const currentMs = Date.parse(timestamp);

    for (const order of this.pendingOrders) {
      if (order.status !== 'PENDING') {
        continue;
      }

      // Check if order was cancelled by linked OCO leg
      if (order.status === 'CANCELLED') {
        continue;
      }

      const currentPrice = prices[order.product_id];
      if (currentPrice === undefined || currentPrice === null) {
        activePending.push(order);
        continue;
      }

      // Check fill conditions
      let filled = false;
      if (order.side === 'BUY') {
        filled = currentPrice <= order.price;
      } else if (order.side === 'SELL') {
        const isStopLoss = order.order_configuration?.limit_limit_gtd;
        if (isStopLoss) {
          filled = currentPrice <= order.price;
        } else {
          filled = currentPrice >= order.price;
        }
      }

      if (filled) {
        order.status = 'FILLED';
        order.filledAt = timestamp;
        order.fillPrice = currentPrice;

        // Cancel linked OCO order immediately
        if (order.link_id) {
          for (const pending of this.pendingOrders) {
            if (pending.link_id === order.link_id && pending.order_id !== order.order_id && pending.status === 'PENDING') {
              pending.status = 'CANCELLED';
              if (!pending.validate_only) {
                const locked = this.lockedUnits.get(order.product_id) ?? 0;
                this.lockedUnits.set(order.product_id, Math.max(0, locked - pending.quantity));
              }
            }
          }
        }

        if (!order.validate_only) {
          const gross = order.quantity * order.price;
          let nextUnits = 0;
          if (order.side === 'BUY') {
            this.lockedCash = Math.max(0, this.lockedCash - gross);
            this.cash -= gross;
            const currentUnits = this.getUnits(order.product_id);
            nextUnits = currentUnits + order.quantity;
            this.positions.set(order.product_id, nextUnits);
            
            const previousAvg = this.avgEntry.get(order.product_id) ?? order.price;
            const nextAvg = nextUnits > 0
              ? (((currentUnits * previousAvg) + gross) / nextUnits)
              : previousAvg;
            this.avgEntry.set(order.product_id, nextAvg);

            // Auto-hedge: generate GTC Profit-Taker and GTD Stop-Loss exit orders on BUY fills
            const hedge = order.order_configuration?.auto_hedge;
            if (hedge) {
              const profitPct = Number(hedge.profit_target_pct || 0.02);
              const stopPct = Number(hedge.stop_loss_pct || 0.015);
              const durationMs = Number(hedge.stop_duration_ms || 900000);
              const profitPrice = currentPrice * (1 + profitPct);
              const stopPrice = currentPrice * (1 - stopPct);
              const end_time = new Date(currentMs + durationMs).toISOString();
              const link_id = `oco_${order.order_id}_${Date.now()}`;

              this.postOrder({
                product_id: order.product_id,
                side: 'SELL',
                validate_only: false,
                timestamp,
                link_id,
                order_configuration: {
                  limit_limit_gtc: {
                    base_size: String(order.quantity),
                    limit_price: String(profitPrice),
                  }
                }
              });

              this.postOrder({
                product_id: order.product_id,
                side: 'SELL',
                validate_only: false,
                timestamp,
                link_id,
                order_configuration: {
                  limit_limit_gtd: {
                    base_size: String(order.quantity),
                    limit_price: String(stopPrice),
                    end_time,
                  }
                }
              });
            }
          } else {
            const locked = this.lockedUnits.get(order.product_id) ?? 0;
            this.lockedUnits.set(order.product_id, Math.max(0, locked - order.quantity));
            this.cash += gross;
            const currentUnits = this.getUnits(order.product_id);
            nextUnits = Math.max(0, currentUnits - order.quantity);
            this.positions.set(order.product_id, nextUnits);
          }

          const fill = {
            accepted: true,
            timestamp,
            symbol: order.product_id,
            side: order.side,
            quantity: order.quantity,
            price: order.price,
            gross,
            remainingCash: this.cash,
            remainingUnits: nextUnits,
          };
          this.orders.push(fill);
          filledOrders.push(fill);
        } else {
          const fill = {
            accepted: true,
            timestamp,
            symbol: order.product_id,
            side: order.side,
            quantity: order.quantity,
            price: order.price,
            gross: 0,
            remainingCash: this.cash,
            remainingUnits: this.getUnits(order.product_id),
            validate_only: true,
          };
          this.orders.push(fill);
          filledOrders.push(fill);
        }
      } else {
        if (order.validate_only) {
          const delta = currentPrice - order.price;
          order.virtualPnL = order.side === 'BUY' ? delta * order.quantity : -delta * order.quantity;
        }

        const isGtd = order.order_configuration?.limit_limit_gtd;
        let expired = false;
        if (isGtd) {
          const endTimeMs = Date.parse(isGtd.end_time);
          if (!isNaN(endTimeMs) && currentMs >= endTimeMs) {
            expired = true;
          }
        }

        if (expired) {
          order.status = 'EXPIRED';
          if (!order.validate_only) {
            if (order.link_id) {
              // Expiring one leg of OCO cancels the other leg too
              for (const pending of this.pendingOrders) {
                if (pending.link_id === order.link_id && pending.order_id !== order.order_id && pending.status === 'PENDING') {
                  pending.status = 'CANCELLED';
                }
              }
              const locked = this.lockedUnits.get(order.product_id) ?? 0;
              this.lockedUnits.set(order.product_id, Math.max(0, locked - order.quantity));
            } else {
              const gross = order.quantity * order.price;
              if (order.side === 'BUY') {
                this.lockedCash = Math.max(0, this.lockedCash - gross);
              } else {
                const locked = this.lockedUnits.get(order.product_id) ?? 0;
                this.lockedUnits.set(order.product_id, Math.max(0, locked - order.quantity));
              }
            }
          }
          this.orders.push(order);
        } else {
          activePending.push(order);
        }
      }
    }

    // Clean up cancelled orders from activePending list
    this.pendingOrders = activePending.filter((o) => o.status === 'PENDING');
    if (filledOrders.length > 0 || this.pendingOrders.length !== activePending.length) {
      this.saveState();
    }
    return filledOrders;
  }

  cancelOrder(orderId) {
    const order = this.pendingOrders.find((o) => o.order_id === orderId);
    if (order && order.status === 'PENDING') {
      order.status = 'CANCELLED';
      if (!order.validate_only) {
        const gross = order.quantity * order.price;
        if (order.side === 'BUY') {
          this.lockedCash = Math.max(0, this.lockedCash - gross);
        } else {
          const locked = this.lockedUnits.get(order.product_id) ?? 0;
          this.lockedUnits.set(order.product_id, Math.max(0, locked - order.quantity));
        }
      }
      this.saveState();
      return { success: true };
    }
    return { success: false, reason: 'ORDER_NOT_FOUND_OR_NOT_PENDING' };
  }

  getCodecMetrics() {
    const guessOrders = this.orders.concat(this.pendingOrders).filter(o => o.validate_only);
    const totalVirtualPnL = guessOrders.reduce((sum, o) => sum + (o.virtualPnL || 0), 0);
    const filledLimitCount = this.orders.filter(o => !o.validate_only && o.status === 'FILLED').length;
    const expiredLimitCount = this.orders.filter(o => !o.validate_only && o.status === 'EXPIRED').length;

    return {
      totalVirtualPnL,
      guessCount: guessOrders.length,
      filledLimitCount,
      expiredLimitCount,
    };
  }
}