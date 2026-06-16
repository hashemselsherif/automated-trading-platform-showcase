const axios = require('axios');

const DEFAULT_PERPS_API = 'https://perps-api.jup.ag/v1';
const DEFAULT_CACHE_MS = Number(process.env.MARK_PRICE_CACHE_MS || 3_000);

/**
 * MarkPriceFeed - Fetches mark prices from Jupiter Perps API
 * 
 * IMPORTANT: The Jupiter Perps API v1 does NOT expose a public endpoint for fetching
 * mark prices for arbitrary markets. The `/v1/markets/{SYMBOL}` endpoint returns 404.
 * 
 * Mark prices are only available:
 * 1. Through the `/positions` endpoint when you have open positions
 * 2. Not available as general market data
 * 
 * This class will gracefully return null values, and the bot will fall back to
 * using the regular price (from Jupiter Swap API) for risk management.
 */
class MarkPriceFeed {
  constructor(options = {}) {
    this.apiUrl = (options.apiUrl || DEFAULT_PERPS_API).replace(/\/$/, '');
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 5_000;
    this.cacheTtlMs = Number.isFinite(options.cacheTtlMs) ? options.cacheTtlMs : DEFAULT_CACHE_MS;
    this.cache = new Map();
    // Disable API calls by default since the endpoint doesn't exist
    // Set ENABLE_MARK_PRICE_API=true to attempt API calls (will still fail gracefully)
    this.enabled = process.env.ENABLE_MARK_PRICE_API === 'true';
    if (!this.enabled) {
      this._warnedOnce = false;
    }
  }

  _cacheKey(symbol) {
    return symbol.toUpperCase();
  }

  _coerceNumber(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }

  async _fetchMarkPrice(symbol) {
    // Skip API call if disabled (endpoint doesn't exist)
    if (!this.enabled) {
      if (!this._warnedOnce) {
        console.warn(`⚠️  Mark price API disabled: Jupiter Perps API v1 does not expose a public endpoint for mark prices.`);
        console.warn(`    The /v1/markets/{SYMBOL} endpoint returns 404. Bot will use regular price for risk management.`);
        console.warn(`    Set ENABLE_MARK_PRICE_API=true to attempt API calls (will still fail gracefully).`);
        this._warnedOnce = true;
      }
      return {
        markPrice: null,
        indexPrice: null,
        lastPrice: null,
        raw: null,
        error: `Mark price API disabled: endpoint does not exist`,
      };
    }

    const encodedSymbol = encodeURIComponent(symbol.toUpperCase());
    const url = `${this.apiUrl}/markets/${encodedSymbol}`;
    
    try {
      const { data } = await axios.get(url, { timeout: this.timeoutMs });

      const markPrice = this._coerceNumber(data?.markPrice ?? data?.mark); // markPrice preferred
      const indexPrice = this._coerceNumber(data?.indexPrice ?? data?.oraclePrice ?? data?.fairPrice);
      const lastPrice = this._coerceNumber(data?.lastPrice ?? data?.lastTradedPrice ?? data?.price ?? data?.markPrice);

      return {
        markPrice,
        indexPrice,
        lastPrice,
        raw: data,
      };
    } catch (error) {
      // Handle 404 or other API errors gracefully
      if (error.response?.status === 404) {
        // The /v1/markets/{SYMBOL} endpoint does not exist in Jupiter Perps API v1
        // Mark prices are only available through /positions endpoint when you have positions
        console.warn(`⚠️  Mark price API returned 404 for ${symbol}.`);
        console.warn(`    The /v1/markets/{SYMBOL} endpoint does not exist in Jupiter Perps API v1.`);
        console.warn(`    Mark prices are only available through /positions endpoint when you have open positions.`);
        console.warn(`    Bot will fall back to regular price for risk management.`);
        // Return null values - bot will fall back to regular price
        return {
          markPrice: null,
          indexPrice: null,
          lastPrice: null,
          raw: null,
          error: `404: Endpoint does not exist - mark prices only available via /positions when you have positions`,
        };
      }
      // Re-throw other errors
      throw error;
    }
  }

  async getMarkPrice(symbol) {
    if (!symbol) throw new Error('MarkPriceFeed: symbol required');

    const cacheKey = this._cacheKey(symbol);
    const cached = this.cache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.timestamp < this.cacheTtlMs) {
      return cached.data;
    }

    const result = await this._fetchMarkPrice(symbol);
    this.cache.set(cacheKey, { timestamp: now, data: result });
    return result;
  }
}

module.exports = MarkPriceFeed;

