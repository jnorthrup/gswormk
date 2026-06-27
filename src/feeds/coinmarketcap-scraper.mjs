import puppeteer from 'puppeteer';

export class CoinMarketCapScraper {
  constructor({ storage } = {}) {
    this.storage = storage;
  }

  async scrapeRsiData() {
    console.log('[Scraper] Launching headless browser to scrape CoinMarketCap RSI...');
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
      ],
    });

    try {
      const page = await browser.newPage();
      await page.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );

      console.log('[Scraper] Navigating to https://coinmarketcap.com/charts/rsi/ ...');
      await page.goto('https://coinmarketcap.com/charts/rsi/', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });

      console.log('[Scraper] Waiting 5s for page script execution and charts to load...');
      await new Promise((r) => setTimeout(r, 5000));

      const nextDataStr = await page.evaluate(() => {
        const script = document.getElementById('__NEXT_DATA__');
        return script ? script.textContent : null;
      });

      if (!nextDataStr) {
        throw new Error('__NEXT_DATA__ script block not found in loaded page DOM');
      }

      console.log('[Scraper] Successfully extracted next-js data from DOM. Parsing...');
      const nextData = JSON.parse(nextDataStr);

      const pageProps = nextData?.props?.pageProps;
      if (!pageProps) {
        throw new Error('pageProps not found in nextData JSON structure');
      }

      // Check lists or properties inside pageProps
      const list = pageProps.data?.list || pageProps.cryptoList || pageProps.list || [];
      console.log(`[Scraper] Found ${list.length} crypto items in nextData.`);

      let count = 0;
      for (const item of list) {
        const symbol = `${item.symbol}-USD`;
        const price = Number(item.price || item.quote?.USD?.price || 0);
        const change24h = Number(item.change24h || item.quote?.USD?.percentChange24h || 0);
        
        // Extract RSI fields
        const rsi1d = Number(item.rsi1d || item.rsi?.d1 || item.rsi || null);
        const rsi1h = Number(item.rsi1h || item.rsi?.h1 || null);

        if (symbol && price > 0) {
          await this.storage.upsertSpotMarketStats({
            symbol,
            price,
            change24h,
            rsi1d,
            rsi1h,
            updatedAt: new Date().toISOString(),
          });
          count += 1;
        }
      }

      console.log(`[Scraper] Successfully scraped and upserted ${count} spot market stats from CMC.`);
      return count;
    } catch (error) {
      console.error('[Scraper] Scrape execution failed:', error.message);
      throw error;
    } finally {
      await browser.close();
    }
  }
}
