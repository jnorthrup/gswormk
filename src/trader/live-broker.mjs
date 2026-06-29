import { generateJwt } from '@coinbase/cdp-sdk/auth';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE_URL = 'https://api.coinbase.com/api/v3/brokerage';

export class LiveBroker {
  constructor({
    cdpApiKeyPath = resolve(process.env.HOME, '.cdp/cdp_api_key.json'),
    portfolioUuid = null,
    baseUrl = BASE_URL,
  } = {}) {
    this.cdpApiKeyPath = cdpApiKeyPath;
    this.portfolioUuid = portfolioUuid;
    this.baseUrl = baseUrl;
    this.keyData = this.loadKey(cdpApiKeyPath);
    this.accountsCache = new Map();
    this.positionsCache = new Map();
  }

  loadKey(path) {
    try {
      const raw = readFileSync(path, 'utf8');
      return JSON.parse(raw);
    } catch (e) {
      throw new Error(`Failed to load CDP key from ${path}: ${e.message}`);
    }
  }

  async getJwt({ requestMethod, requestPath }) {
    const apiKeyId = this.keyData.name || this.keyData.id;
    if (!apiKeyId) throw new Error('Key name/id is required');
    return generateJwt({
      apiKeyId,
      apiKeySecret: this.keyData.privateKey,
      requestMethod,
      requestHost: new URL(this.baseUrl).host,
      requestPath,
      expiresIn: 120,
    });
  }

  async fetchWithAuth({ method, path, body }) {
    const jwt = await this.getJwt({ requestMethod: method, requestPath: path });
    const url = `${this.baseUrl}${path}`;
    const headers = {
      'Authorization': `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    const options = { method, headers };
    if (body) options.body = JSON.stringify(body);
    const response = await fetch(url, options);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    return response.json();
  }

  // Portfolio management
  async listPortfolios() {
    return this.fetchWithAuth({ method: 'GET', path: '/portfolios' });
  }

  async createPortfolio(name) {
    return this.fetchWithAuth({
      method: 'POST',
      path: '/portfolios',
      body: { name },
    });
  }

  async getPortfolioBalances(portfolioUuid = this.portfolioUuid) {
    if (!portfolioUuid) throw new Error('portfolioUuid required');
    return this.fetchWithAuth({ method: 'GET', path: `/portfolios/${portfolioUuid}/balances` });
  }

  async getPositions(portfolioUuid = this.portfolioUuid) {
    if (!portfolioUuid) throw new Error('portfolioUuid required');
    return this.fetchWithAuth({ method: 'GET', path: `/portfolios/${portfolioUuid}/positions` });
  }

  // Account & balances
  async getAccounts() {
    return this.fetchWithAuth({ method: 'GET', path: '/accounts' });
  }

  async getAccount(accountUuid) {
    return this.fetchWithAuth({ method: 'GET', path: `/accounts/${accountUuid}` });
  }

  // Order management
  async createOrder(orderConfig) {
    const body = {
      client_order_id: orderConfig.clientOrderId || `order_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      product_id: orderConfig.productId,
      side: orderConfig.side,
      order_configuration: orderConfig.orderConfiguration,
    };
    if (this.portfolioUuid) body.portfolio_uuid = this.portfolioUuid;
    return this.fetchWithAuth({ method: 'POST', path: '/orders', body });
  }

  async listOrders(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.fetchWithAuth({ method: 'GET', path: `/orders?${query}` });
  }

  async getOrder(orderId) {
    return this.fetchWithAuth({ method: 'GET', path: `/orders/${orderId}` });
  }

  async cancelOrder(orderId) {
    return this.fetchWithAuth({ method: 'DELETE', path: `/orders/${orderId}` });
  }

  async getFills(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.fetchWithAuth({ method: 'GET', path: `/fills?${query}` });
  }

  // Order configuration builders
  static buildMarketOrder({ side, baseSize, quoteSize }) {
    const config = side === 'BUY'
      ? { market_market_ioc: { quote_size: String(quoteSize) } }
      : { market_market_ioc: { base_size: String(baseSize) } };
    return config;
  }

  static buildLimitOrder({ side, baseSize, limitPrice, timeInForce = 'GTC', postOnly = false }) {
    const key = timeInForce === 'GTD' ? 'limit_limit_gtd' : 'limit_limit_gtc';
    const config = {
      [key]: {
        base_size: String(baseSize),
        limit_price: String(limitPrice),
        post_only: postOnly,
      },
    };
    if (timeInForce === 'GTD') {
      config[key].end_time = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    }
    return config;
  }

  static buildStopLimitOrder({ side, baseSize, limitPrice, stopPrice, timeInForce = 'GTC' }) {
    const key = timeInForce === 'GTD' ? 'stop_limit_stop_limit_gtd' : 'stop_limit_stop_limit_gtc';
    const config = {
      [key]: {
        base_size: String(baseSize),
        limit_price: String(limitPrice),
        stop_price: String(stopPrice),
      };
    if (timeInForce === 'GTD') {
      config[key].end_time = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    }
    return config;
  }

  static buildBracketOrder({ side, baseSize, limitPrice, stopTriggerPrice, timeInForce = 'GTC' }) {
    const key = timeInForce === 'GTD' ? 'trigger_bracket_gtd' : 'trigger_bracket_gtc';
    return {
      [key]: {
        base_size: String(baseSize),
        limit_price: String(limitPrice),
        stop_trigger_price: String(stopTriggerPrice),
      },
    };
  }

  static buildAttachedTPSL({ limitPrice, stopTriggerPrice }) {
    return {
      attached_order_configuration: {
        trigger_bracket_gtc: {
          limit_price: String(limitPrice),
          stop_trigger_price: String(stopTriggerPrice),
        },
      },
    };
  }

  // Sync state methods (for engine compatibility)
  async syncState() {
    const [accounts, balances, positions] = await Promise.all([
      this.getAccounts(),
      this.getPortfolioBalances(),
      this.getPositions(),
    ]);
    this.accountsCache = new Map(accounts.accounts?.map(a => [a.uuid, a]) || []);
    this.positionsCache = new Map(positions.positions?.map(p => [p.product_id, p]) || []);
    return { accounts, balances, positions };
  }

  getPosition(productId) {
    return this.positionsCache.get(productId) || null;
  }

  getCash() {
    const usdAccount = [...this.accountsCache.values()].find(a => a.currency === 'USD');
    return usdAccount ? Number(usdAccount.available_balance?.value || 0) : 0;
  }

  getPortfolioNav() {
    // Would need to compute from positions + balances
    return 0;
  }
}

export default LiveBroker;