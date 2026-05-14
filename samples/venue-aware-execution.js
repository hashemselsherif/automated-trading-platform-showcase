/**
 * Representative excerpt adapted from the live execution layer.
 * Orders route by market, venue state, and execution mode rather than using
 * a single exchange client for every trade.
 */

class VenueAwareExecution {
  constructor({ primaryVenueClient, altVenueClient, mode = "limited_live" }) {
    this.primaryVenueClient = primaryVenueClient;
    this.altVenueClient = altVenueClient;
    this.mode = mode;
    this.positionVenueMap = new Map();
  }

  async openPosition(request) {
    const venue = this.resolveVenue(request.marketSymbol);

    if (venue === "alt") {
      return this.openAltVenue(request);
    }

    return this.openPrimaryVenue(request);
  }

  resolveVenue(marketSymbol) {
    return marketSymbol.endsWith("SOL-PERP") ||
      marketSymbol.endsWith("BTC-PERP") ||
      marketSymbol.endsWith("ETH-PERP")
      ? "primary"
      : "alt";
  }

  async openPrimaryVenue(request) {
    const position = await this.withRetries(() =>
      this.primaryVenueClient.openPosition(request)
    );
    this.positionVenueMap.set(position.positionId, "primary");
    return position;
  }

  async openAltVenue(request) {
    if (this.mode === "shadow_only") {
      return {
        status: "shadow_trade_recorded",
        marketSymbol: request.marketSymbol,
      };
    }

    const position = await this.withRetries(() =>
      this.altVenueClient.openPosition(request)
    );
    this.positionVenueMap.set(position.positionId, "alt");
    return position;
  }

  async withRetries(fn, retries = 2, delayMs = 1500) {
    let lastError = null;

    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (attempt < retries) {
          await sleep(delayMs);
        }
      }
    }

    throw lastError;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = VenueAwareExecution;
