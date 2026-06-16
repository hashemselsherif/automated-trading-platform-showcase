/**
 * TypedCandleArray - Memory-efficient candle storage using Float64Array
 * 
 * Reduces memory usage by ~60% compared to object arrays:
 * - Object array: ~200 bytes per candle (11 fields + object overhead)
 * - TypedArray: ~88 bytes per candle (11 Float64 values)
 * 
 * For 518K candles per market:
 * - Object: ~104 MB
 * - TypedArray: ~46 MB
 * 
 * With 14 markets, this saves ~800MB of memory.
 */

// Field indices for the typed array
const FIELD_OPEN_TIME = 0;
const FIELD_CLOSE_TIME = 1;
const FIELD_OPEN = 2;
const FIELD_HIGH = 3;
const FIELD_LOW = 4;
const FIELD_CLOSE = 5;
const FIELD_BASE_VOLUME = 6;
const FIELD_QUOTE_VOLUME = 7;
const FIELD_TRADE_COUNT = 8;
const FIELD_TAKER_BASE_VOLUME = 9;
const FIELD_TAKER_QUOTE_VOLUME = 10;

const FIELDS_PER_CANDLE = 11;

/**
 * TypedCandleArray - stores candles in a contiguous Float64Array
 */
class TypedCandleArray {
  /**
   * @param {number} capacity - Maximum number of candles to store
   */
  constructor(capacity = 0) {
    this._capacity = capacity;
    this._length = 0;
    this._buffer = capacity > 0 ? new Float64Array(capacity * FIELDS_PER_CANDLE) : null;
    // Index for fast lookups by closeTime
    this._closeTimeIndex = null;
  }

  /**
   * Create from an array of candle objects
   * @param {Array} candles - Array of candle objects
   * @returns {TypedCandleArray}
   */
  static fromObjects(candles) {
    if (!candles || candles.length === 0) {
      return new TypedCandleArray(0);
    }

    const arr = new TypedCandleArray(candles.length);
    for (let i = 0; i < candles.length; i++) {
      arr.push(candles[i]);
    }
    return arr;
  }

  /**
   * Get the number of candles
   */
  get length() {
    return this._length;
  }

  /**
   * Push a candle object
   * @param {Object} candle
   */
  push(candle) {
    if (this._length >= this._capacity) {
      // Grow buffer by 50%
      const newCapacity = Math.max(this._capacity * 1.5, this._capacity + 1000);
      this._grow(Math.ceil(newCapacity));
    }

    const offset = this._length * FIELDS_PER_CANDLE;
    this._buffer[offset + FIELD_OPEN_TIME] = Number(candle.openTime) || 0;
    this._buffer[offset + FIELD_CLOSE_TIME] = Number(candle.closeTime) || 0;
    this._buffer[offset + FIELD_OPEN] = Number(candle.open) || 0;
    this._buffer[offset + FIELD_HIGH] = Number(candle.high) || 0;
    this._buffer[offset + FIELD_LOW] = Number(candle.low) || 0;
    this._buffer[offset + FIELD_CLOSE] = Number(candle.close) || 0;
    this._buffer[offset + FIELD_BASE_VOLUME] = Number(candle.baseVolume ?? candle.volume ?? 0);
    this._buffer[offset + FIELD_QUOTE_VOLUME] = Number(candle.quoteVolume ?? candle.takerQuoteVolume ?? 0);
    this._buffer[offset + FIELD_TRADE_COUNT] = Number(candle.tradeCount ?? candle.trades ?? 0);
    this._buffer[offset + FIELD_TAKER_BASE_VOLUME] = Number(candle.takerBaseVolume ?? candle.takerBase ?? 0);
    this._buffer[offset + FIELD_TAKER_QUOTE_VOLUME] = Number(candle.takerQuoteVolume ?? candle.takerQuote ?? 0);

    this._length++;
    this._closeTimeIndex = null; // Invalidate index
  }

  /**
   * Get candle at index as an object (for backward compatibility)
   * @param {number} index
   * @returns {Object|null}
   */
  get(index) {
    if (index < 0 || index >= this._length) return null;

    const offset = index * FIELDS_PER_CANDLE;
    return {
      openTime: this._buffer[offset + FIELD_OPEN_TIME],
      closeTime: this._buffer[offset + FIELD_CLOSE_TIME],
      open: this._buffer[offset + FIELD_OPEN],
      high: this._buffer[offset + FIELD_HIGH],
      low: this._buffer[offset + FIELD_LOW],
      close: this._buffer[offset + FIELD_CLOSE],
      baseVolume: this._buffer[offset + FIELD_BASE_VOLUME],
      quoteVolume: this._buffer[offset + FIELD_QUOTE_VOLUME],
      tradeCount: this._buffer[offset + FIELD_TRADE_COUNT],
      takerBaseVolume: this._buffer[offset + FIELD_TAKER_BASE_VOLUME],
      takerQuoteVolume: this._buffer[offset + FIELD_TAKER_QUOTE_VOLUME],
    };
  }

  /**
   * Get a specific field value without creating an object
   * @param {number} index
   * @param {string} field
   * @returns {number}
   */
  getField(index, field) {
    if (index < 0 || index >= this._length) return NaN;

    const offset = index * FIELDS_PER_CANDLE;
    switch (field) {
      case 'openTime': return this._buffer[offset + FIELD_OPEN_TIME];
      case 'closeTime': return this._buffer[offset + FIELD_CLOSE_TIME];
      case 'open': return this._buffer[offset + FIELD_OPEN];
      case 'high': return this._buffer[offset + FIELD_HIGH];
      case 'low': return this._buffer[offset + FIELD_LOW];
      case 'close': return this._buffer[offset + FIELD_CLOSE];
      case 'baseVolume': 
      case 'volume': return this._buffer[offset + FIELD_BASE_VOLUME];
      case 'quoteVolume': return this._buffer[offset + FIELD_QUOTE_VOLUME];
      case 'tradeCount':
      case 'trades': return this._buffer[offset + FIELD_TRADE_COUNT];
      case 'takerBaseVolume': return this._buffer[offset + FIELD_TAKER_BASE_VOLUME];
      case 'takerQuoteVolume': return this._buffer[offset + FIELD_TAKER_QUOTE_VOLUME];
      default: return NaN;
    }
  }

  /**
   * Find candle index by closeTime using binary search
   * @param {number} closeTime
   * @returns {number} Index or -1 if not found
   */
  findByCloseTime(closeTime) {
    if (this._length === 0) return -1;

    // Binary search
    let left = 0;
    let right = this._length - 1;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const midTime = this._buffer[mid * FIELDS_PER_CANDLE + FIELD_CLOSE_TIME];

      if (midTime === closeTime) return mid;
      if (midTime < closeTime) left = mid + 1;
      else right = mid - 1;
    }

    return -1;
  }

  /**
   * Build an index for fast closeTime lookups
   */
  buildCloseTimeIndex() {
    if (this._closeTimeIndex) return;

    this._closeTimeIndex = new Map();
    for (let i = 0; i < this._length; i++) {
      const closeTime = this._buffer[i * FIELDS_PER_CANDLE + FIELD_CLOSE_TIME];
      this._closeTimeIndex.set(closeTime, i);
    }
  }

  /**
   * Get index by closeTime using the pre-built index
   * @param {number} closeTime
   * @returns {number}
   */
  getIndexByCloseTime(closeTime) {
    if (!this._closeTimeIndex) this.buildCloseTimeIndex();
    return this._closeTimeIndex.get(closeTime) ?? -1;
  }

  /**
   * Convert to array of objects (for backward compatibility with existing code)
   * @returns {Array}
   */
  toObjectArray() {
    const result = new Array(this._length);
    for (let i = 0; i < this._length; i++) {
      result[i] = this.get(i);
    }
    return result;
  }

  /**
   * Iterate over candles (for backward compatibility with for...of)
   */
  *[Symbol.iterator]() {
    for (let i = 0; i < this._length; i++) {
      yield this.get(i);
    }
  }

  /**
   * Filter candles by predicate
   * @param {Function} predicate - (candle, index) => boolean
   * @returns {TypedCandleArray}
   */
  filter(predicate) {
    const filtered = new TypedCandleArray(this._length);
    for (let i = 0; i < this._length; i++) {
      const candle = this.get(i);
      if (predicate(candle, i)) {
        filtered.push(candle);
      }
    }
    return filtered;
  }

  /**
   * Map candles to new values
   * @param {Function} mapper - (candle, index) => newValue
   * @returns {Array}
   */
  map(mapper) {
    const result = new Array(this._length);
    for (let i = 0; i < this._length; i++) {
      result[i] = mapper(this.get(i), i);
    }
    return result;
  }

  /**
   * ForEach iteration
   * @param {Function} callback - (candle, index) => void
   */
  forEach(callback) {
    for (let i = 0; i < this._length; i++) {
      callback(this.get(i), i);
    }
  }

  /**
   * Slice to get a subset
   * @param {number} start
   * @param {number} end
   * @returns {TypedCandleArray}
   */
  slice(start = 0, end = this._length) {
    if (start < 0) start = Math.max(0, this._length + start);
    if (end < 0) end = Math.max(0, this._length + end);
    end = Math.min(end, this._length);

    const sliceLen = Math.max(0, end - start);
    const result = new TypedCandleArray(sliceLen);

    if (sliceLen > 0) {
      const srcOffset = start * FIELDS_PER_CANDLE;
      const copyLen = sliceLen * FIELDS_PER_CANDLE;
      result._buffer = new Float64Array(copyLen);
      result._buffer.set(this._buffer.subarray(srcOffset, srcOffset + copyLen));
      result._length = sliceLen;
      result._capacity = sliceLen;
    }

    return result;
  }

  /**
   * Get memory usage in bytes
   * @returns {number}
   */
  getMemoryUsage() {
    return this._buffer ? this._buffer.byteLength : 0;
  }

  /**
   * Clear all data and release memory
   */
  clear() {
    this._buffer = null;
    this._length = 0;
    this._capacity = 0;
    this._closeTimeIndex = null;
  }

  /**
   * Grow the internal buffer
   * @private
   */
  _grow(newCapacity) {
    const newBuffer = new Float64Array(newCapacity * FIELDS_PER_CANDLE);
    if (this._buffer) {
      newBuffer.set(this._buffer);
    }
    this._buffer = newBuffer;
    this._capacity = newCapacity;
  }
}

/**
 * Wrapper that makes TypedCandleArray behave like a regular array
 * for maximum backward compatibility
 */
class TypedCandleArrayProxy {
  constructor(typedArray) {
    this._typed = typedArray;
    
    // Create a Proxy to intercept array-like access
    return new Proxy(this, {
      get(target, prop) {
        // Handle numeric indices
        if (typeof prop === 'string' && /^\d+$/.test(prop)) {
          return target._typed.get(Number(prop));
        }
        
        // Handle length
        if (prop === 'length') {
          return target._typed.length;
        }
        
        // Handle Symbol.iterator
        if (prop === Symbol.iterator) {
          return target._typed[Symbol.iterator].bind(target._typed);
        }
        
        // Handle array methods
        if (prop === 'filter') return target._typed.filter.bind(target._typed);
        if (prop === 'map') return target._typed.map.bind(target._typed);
        if (prop === 'forEach') return target._typed.forEach.bind(target._typed);
        if (prop === 'slice') {
          return (start, end) => {
            const sliced = target._typed.slice(start, end);
            return new TypedCandleArrayProxy(sliced);
          };
        }
        if (prop === 'find') {
          return (predicate) => {
            for (let i = 0; i < target._typed.length; i++) {
              const candle = target._typed.get(i);
              if (predicate(candle, i)) return candle;
            }
            return undefined;
          };
        }
        if (prop === 'findIndex') {
          return (predicate) => {
            for (let i = 0; i < target._typed.length; i++) {
              const candle = target._typed.get(i);
              if (predicate(candle, i)) return i;
            }
            return -1;
          };
        }
        if (prop === 'reduce') {
          return (reducer, initial) => {
            let acc = initial;
            for (let i = 0; i < target._typed.length; i++) {
              acc = reducer(acc, target._typed.get(i), i);
            }
            return acc;
          };
        }
        if (prop === 'some') {
          return (predicate) => {
            for (let i = 0; i < target._typed.length; i++) {
              if (predicate(target._typed.get(i), i)) return true;
            }
            return false;
          };
        }
        if (prop === 'every') {
          return (predicate) => {
            for (let i = 0; i < target._typed.length; i++) {
              if (!predicate(target._typed.get(i), i)) return false;
            }
            return true;
          };
        }
        
        // Handle typed array methods
        if (prop === 'getField') return target._typed.getField.bind(target._typed);
        if (prop === 'findByCloseTime') return target._typed.findByCloseTime.bind(target._typed);
        if (prop === 'getIndexByCloseTime') return target._typed.getIndexByCloseTime.bind(target._typed);
        if (prop === 'buildCloseTimeIndex') return target._typed.buildCloseTimeIndex.bind(target._typed);
        if (prop === 'toObjectArray') return target._typed.toObjectArray.bind(target._typed);
        if (prop === 'getMemoryUsage') return target._typed.getMemoryUsage.bind(target._typed);
        if (prop === 'clear') return target._typed.clear.bind(target._typed);
        if (prop === '_typed') return target._typed;
        
        // Default
        return target[prop];
      },
      
      has(target, prop) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) {
          const idx = Number(prop);
          return idx >= 0 && idx < target._typed.length;
        }
        return prop in target || prop in target._typed;
      },
      
      ownKeys(target) {
        const keys = [];
        for (let i = 0; i < target._typed.length; i++) {
          keys.push(String(i));
        }
        keys.push('length');
        return keys;
      },
      
      getOwnPropertyDescriptor(target, prop) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) {
          const idx = Number(prop);
          if (idx >= 0 && idx < target._typed.length) {
            return {
              value: target._typed.get(idx),
              writable: false,
              enumerable: true,
              configurable: true,
            };
          }
        }
        if (prop === 'length') {
          return {
            value: target._typed.length,
            writable: false,
            enumerable: false,
            configurable: true,
          };
        }
        return undefined;
      },
    });
  }
}

/**
 * Create a TypedCandleArray from objects with a Proxy wrapper for backward compatibility
 * @param {Array} candles
 * @returns {TypedCandleArrayProxy}
 */
function createTypedCandleArray(candles) {
  const typed = TypedCandleArray.fromObjects(candles);
  return new TypedCandleArrayProxy(typed);
}

/**
 * Check if an object is a TypedCandleArray or proxy
 * @param {any} obj
 * @returns {boolean}
 */
function isTypedCandleArray(obj) {
  return obj instanceof TypedCandleArray || 
         (obj && obj._typed instanceof TypedCandleArray);
}

module.exports = {
  TypedCandleArray,
  TypedCandleArrayProxy,
  createTypedCandleArray,
  isTypedCandleArray,
  FIELDS_PER_CANDLE,
  // Field constants for direct buffer access
  FIELD_OPEN_TIME,
  FIELD_CLOSE_TIME,
  FIELD_OPEN,
  FIELD_HIGH,
  FIELD_LOW,
  FIELD_CLOSE,
  FIELD_BASE_VOLUME,
  FIELD_QUOTE_VOLUME,
  FIELD_TRADE_COUNT,
  FIELD_TAKER_BASE_VOLUME,
  FIELD_TAKER_QUOTE_VOLUME,
};

