import puppeteer from 'puppeteer';

const RSI_PAGE_URL = 'https://coinmarketcap.com/charts/rsi/';
const RSI_API_URL = 'https://api.coinmarketcap.com/data-api/v3/cryptocurrency/rsi/heatmap/table';
const CMC_MAIN_PAGE_PREFIX = 'https://coinmarketcap.com/currencies/';
const CMC_KEY_INFO_URL = 'https://pro-api.coinmarketcap.com/v1/key/info';
const DEFAULT_HEADERS = {
  accept: 'application/json',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
} as const;

type ScraperOptions = {
  storage?: any;
  fetchImpl?: typeof fetch;
  browserLauncher?: () => Promise<any>;
  apiKey?: string | null;
};

export class CoinMarketCapScraper {
  storage: any;
  fetchImpl: typeof fetch;
  browserLauncher: () => Promise<any>;
  apiKey: string | null;

  constructor({ storage, fetchImpl = globalThis.fetch, browserLauncher = launchBrowser, apiKey = process.env.COINMARKETCAP_API_KEY ?? null }: ScraperOptions = {}) {
    this.storage = storage;
    this.fetchImpl = fetchImpl;
    this.browserLauncher = browserLauncher;
    this.apiKey = apiKey;
  }

  async scrapeRsiData({ preferBrowser = false }: { preferBrowser?: boolean } = {}): Promise<number> {
    try {
      const list = preferBrowser
        ? await this.fetchRsiHeatmapViaBrowser()
        : await this.fetchRsiHeatmapDirect();
      return await this.persistRsiHeatmap(list);
    } catch (error) {
      const message = (error as Error).message;
      if (preferBrowser) {
        console.error('[Scraper] Scrape execution failed:', message);
        throw error;
      }

      console.warn(`[Scraper] Direct CMC API fetch failed: ${message}. Falling back to browser path...`);
      const list = await this.fetchRsiHeatmapViaBrowser();
      return this.persistRsiHeatmap(list);
    }
  }

  async persistRsiHeatmap(list: any[], { updatedAt = new Date().toISOString() }: { updatedAt?: string } = {}): Promise<number> {
    console.log(`[Scraper] Found ${list.length} crypto items in the CMC RSI API.`);
    let count = 0;

    for (const item of list) {
      const symbol = `${item.symbol}-USD`;
      const price = Number(item.price || 0);
      const change24h = Number(item.price24h || item.change24h || 0);
      const rsi1d = coerceMetric(item.rsi?.rsi24h ?? item.rsi24h ?? item.rsi1d ?? item.rsi?.d1);
      const rsi1h = coerceMetric(item.rsi?.rsi1h ?? item.rsi1h ?? item.rsi?.h1);

      if (symbol && price > 0) {
        if (this.storage?.upsertSpotMarketAsset) {
          await this.storage.upsertSpotMarketAsset(buildCmcAssetRef(item, updatedAt));
        }
        await this.storage.upsertSpotMarketStats({
          symbol,
          price,
          change24h,
          rsi1d,
          rsi1h,
          updatedAt,
        });
        count += 1;
      }
    }

    console.log(`[Scraper] Successfully scraped and upserted ${count} spot market stats from CMC.`);
    return count;
  }

  async fetchRsiHeatmapDirect({ pageSize = 100, maxPages = null }: { pageSize?: number; maxPages?: number | null } = {}): Promise<any[]> {
    console.log('[Scraper] Pulling CoinMarketCap RSI data directly from the API...');
    return fetchRsiHeatmapRows({
      fetchImpl: this.fetchImpl,
      pageSize,
      maxPages,
    });
  }

  async fetchQuotaInfo(): Promise<{
    minuteLimit: number | null;
    minuteRequestsMade: number | null;
    minuteRequestsLeft: number | null;
    monthlyCreditLimit: number | null;
    monthlyCreditsUsed: number | null;
    monthlyCreditsLeft: number | null;
    monthlyResetText: string | null;
    monthlyResetTimestamp: string | null;
  } | null> {
    if (!this.apiKey) {
      return null;
    }

    const response = await this.fetchImpl(CMC_KEY_INFO_URL, {
      headers: {
        ...DEFAULT_HEADERS,
        'X-CMC_PRO_API_KEY': this.apiKey,
      },
    });
    if (!response.ok) {
      throw new Error(`CMC key info returned HTTP ${response.status}`);
    }

    const payload = await response.json() as any;
    const plan = payload?.data?.plan ?? {};
    const usage = payload?.data?.usage ?? {};
    return {
      minuteLimit: plan.rate_limit_minute ?? null,
      minuteRequestsMade: usage.current_minute?.requests_made ?? null,
      minuteRequestsLeft: usage.current_minute?.requests_left ?? null,
      monthlyCreditLimit: plan.credit_limit_monthly ?? null,
      monthlyCreditsUsed: usage.current_month?.credits_used ?? null,
      monthlyCreditsLeft: usage.current_month?.credits_left ?? null,
      monthlyResetText: plan.credit_limit_monthly_reset ?? null,
      monthlyResetTimestamp: plan.credit_limit_monthly_reset_timestamp ?? null,
    };
  }

  async fetchRsiHeatmapViaBrowser({ pageSize = 100, maxPages = null }: { pageSize?: number; maxPages?: number | null } = {}): Promise<any[]> {
    console.log('[Scraper] Launching headless browser to scrape CoinMarketCap RSI...');
    const browser = await this.browserLauncher();
    try {
      const page = await browser.newPage();
      await page.setUserAgent(DEFAULT_HEADERS['user-agent']);

      console.log(`[Scraper] Navigating to ${RSI_PAGE_URL} ...`);
      await page.goto(RSI_PAGE_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });

      console.log('[Scraper] Waiting 5s for page scripts to settle before pulling the RSI API...');
      await new Promise((r) => setTimeout(r, 5000));

      return this.fetchRsiHeatmap(page, { pageSize, maxPages });
    } finally {
      await browser.close();
    }
  }

  async fetchRsiHeatmap(page: any, { pageSize = 100, maxPages = null }: { pageSize?: number; maxPages?: number | null } = {}): Promise<any[]> {
    return page.evaluate(async ({ apiUrl, pageSize, maxPages }: { apiUrl: string; pageSize: number; maxPages: number | null }) => {
      const rows: any[] = [];

      for (let page = 1; ; page += 1) {
        if (maxPages && page > maxPages) {
          break;
        }
        const query = new URLSearchParams({
          limit: String(pageSize),
          page: String(page),
          rsiPeriod: '14',
          'volume24hRange.min': '1000000',
          'marketCapRange.min': '50000000',
          sort: 'rsi4h',
          ascendingOrder: 'false',
        });

        const response = await fetch(`${apiUrl}?${query.toString()}`, {
          credentials: 'include',
          headers: { accept: 'application/json' },
        });
        if (!response.ok) {
          throw new Error(`CMC RSI API returned HTTP ${response.status} for page ${page}`);
        }

        const payload = await response.json() as any;
        const pageRows = payload?.data?.data || [];
        rows.push(...pageRows);

        const totalPages = Number(payload?.data?.pagination?.totalPages || 0);
        if (pageRows.length < pageSize || (totalPages > 0 && page >= totalPages)) {
          break;
        }
      }

      return rows;
    }, { apiUrl: RSI_API_URL, pageSize, maxPages });
  }
}

async function fetchRsiHeatmapRows({ fetchImpl, pageSize = 100, maxPages = null }: { fetchImpl: typeof fetch; pageSize?: number; maxPages?: number | null }): Promise<any[]> {
  const rows: any[] = [];

  for (let page = 1; ; page += 1) {
    if (maxPages && page > maxPages) {
      break;
    }

    const query = new URLSearchParams({
      limit: String(pageSize),
      page: String(page),
      rsiPeriod: '14',
      'volume24hRange.min': '1000000',
      'marketCapRange.min': '50000000',
      sort: 'rsi4h',
      ascendingOrder: 'false',
    });

    const response = await fetchImpl(`${RSI_API_URL}?${query.toString()}`, {
      headers: DEFAULT_HEADERS,
    });
    if (!response.ok) {
      throw new Error(`CMC RSI API returned HTTP ${response.status} for page ${page}`);
    }

    const payload = await response.json() as any;
    const pageRows = payload?.data?.data || [];
    rows.push(...pageRows);

    const totalPages = Number(payload?.data?.pagination?.totalPages || 0);
    if (pageRows.length < pageSize || (totalPages > 0 && page >= totalPages)) {
      break;
    }
  }

  return rows;
}

function buildCmcAssetRef(item: any, updatedAt: string): any {
  const slug = item.slug || null;
  return {
    symbol: `${item.symbol}-USD`,
    baseSymbol: item.symbol || null,
    quoteSymbol: 'USD',
    assetName: item.name || null,
    baseName: item.name || null,
    quoteName: 'US Dollar',
    displayName: item.name ? `${item.name} (${item.symbol})` : `${item.symbol}-USD`,
    cmcAssetId: item.id ? String(item.id) : null,
    cmcSymbol: item.symbol || null,
    cmcName: item.name || null,
    cmcSlug: slug,
    cmcRsiUrl: RSI_PAGE_URL,
    cmcMainPageUrl: slug ? `${CMC_MAIN_PAGE_PREFIX}${slug}/` : null,
    updatedAt,
  };
}

function coerceMetric(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

async function launchBrowser(): Promise<any> {
  return puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
    ],
  });
}
