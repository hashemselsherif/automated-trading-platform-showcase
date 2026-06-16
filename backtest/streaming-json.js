/**
 * Streaming JSON Parser
 * 
 * Parses large JSON array files (~100MB+) in a streaming manner
 * to reduce peak memory usage during parsing.
 * 
 * Standard JSON.parse loads entire file into memory, then creates
 * all objects at once. This can spike memory to 3-4x the file size.
 * 
 * Streaming parser processes items one-at-a-time, reducing peak
 * memory to approximately the file size + one item.
 */

const fs = require('fs');
const readline = require('readline');
const path = require('path');

/**
 * Parse a JSON array file in a streaming manner
 * 
 * Expects the file to contain a JSON array where each element is on its own line.
 * This is the format produced by `JSON.stringify(arr, null, 2)`.
 * 
 * @param {string} filePath - Path to JSON file
 * @param {Object} options - Options
 * @param {Function} [options.onItem] - Callback for each item (item, index) => void
 * @param {Function} [options.transform] - Transform function for each item
 * @param {boolean} [options.returnArray=true] - Whether to collect and return all items
 * @param {number} [options.skip=0] - Number of items to skip from the start
 * @param {number} [options.limit=Infinity] - Maximum number of items to process
 * @returns {Promise<Array|number>} Array of items or count if returnArray=false
 */
async function streamParseJsonArray(filePath, options = {}) {
  const {
    onItem,
    transform,
    returnArray = true,
    skip = 0,
    limit = Infinity,
  } = options;

  const results = returnArray ? [] : null;
  let itemCount = 0;
  let buffer = '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  let arrayStarted = false;
  let processedCount = 0;

  const fileStream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
  
  return new Promise((resolve, reject) => {
    fileStream.on('data', (chunk) => {
      for (let i = 0; i < chunk.length; i++) {
        const char = chunk[i];

        // Track string boundaries
        if (escaped) {
          escaped = false;
          if (depth > 0) buffer += char;
          continue;
        }

        if (char === '\\' && inString) {
          escaped = true;
          if (depth > 0) buffer += char;
          continue;
        }

        if (char === '"') {
          inString = !inString;
          if (depth > 0) buffer += char;
          continue;
        }

        if (inString) {
          if (depth > 0) buffer += char;
          continue;
        }

        // Not in a string - parse structure
        if (char === '[') {
          if (!arrayStarted) {
            arrayStarted = true;
            continue;
          }
          depth++;
          buffer += char;
        } else if (char === ']') {
          if (depth === 0) {
            // End of outer array - process any remaining buffer
            if (buffer.trim()) {
              processItem();
            }
            // Don't break - there might be trailing content
          } else {
            depth--;
            buffer += char;
          }
        } else if (char === '{') {
          depth++;
          buffer += char;
        } else if (char === '}') {
          depth--;
          buffer += char;
          if (depth === 0) {
            // Complete object
            processItem();
          }
        } else if (char === ',' && depth === 0) {
          // Separator at top level - item boundary
          // The buffer was already processed when depth returned to 0
          // Skip comma
        } else if (depth > 0 || (char !== ' ' && char !== '\n' && char !== '\r' && char !== '\t')) {
          // Only add to buffer if we're inside an object or it's meaningful whitespace
          if (depth > 0) {
            buffer += char;
          }
        }
      }
    });

    fileStream.on('end', () => {
      // Process any remaining buffer
      if (buffer.trim()) {
        processItem();
      }
      resolve(returnArray ? results : itemCount);
    });

    fileStream.on('error', reject);

    function processItem() {
      if (!buffer.trim()) return;
      if (processedCount >= limit) {
        buffer = '';
        return;
      }

      try {
        const item = JSON.parse(buffer);
        itemCount++;

        if (itemCount > skip) {
          const transformed = transform ? transform(item) : item;
          
          if (onItem) {
            onItem(transformed, processedCount);
          }
          
          if (returnArray) {
            results.push(transformed);
          }
          
          processedCount++;
        }
      } catch (err) {
        // Silently skip malformed items (could log in debug mode)
      }
      buffer = '';
    }
  });
}

/**
 * Stream parse a newline-delimited JSON (NDJSON) file
 * Each line is a separate JSON object
 * 
 * @param {string} filePath - Path to NDJSON file
 * @param {Object} options - Same options as streamParseJsonArray
 * @returns {Promise<Array|number>}
 */
async function streamParseNdjson(filePath, options = {}) {
  const {
    onItem,
    transform,
    returnArray = true,
    skip = 0,
    limit = Infinity,
  } = options;

  const results = returnArray ? [] : null;
  let itemCount = 0;
  let processedCount = 0;

  const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  return new Promise((resolve, reject) => {
    rl.on('line', (line) => {
      if (processedCount >= limit) return;
      
      const trimmed = line.trim();
      if (!trimmed || trimmed === '[' || trimmed === ']') return;
      
      // Remove trailing comma if present
      const json = trimmed.endsWith(',') ? trimmed.slice(0, -1) : trimmed;
      if (!json) return;

      try {
        const item = JSON.parse(json);
        itemCount++;

        if (itemCount > skip) {
          const transformed = transform ? transform(item) : item;
          
          if (onItem) {
            onItem(transformed, processedCount);
          }
          
          if (returnArray) {
            results.push(transformed);
          }
          
          processedCount++;
        }
      } catch (err) {
        // Skip malformed lines
      }
    });

    rl.on('close', () => {
      resolve(returnArray ? results : itemCount);
    });

    rl.on('error', reject);
    fileStream.on('error', reject);
  });
}

/**
 * Determine which parser to use based on file format
 * Samples the first few KB to detect format
 * 
 * @param {string} filePath
 * @returns {Promise<'array'|'ndjson'>}
 */
async function detectJsonFormat(filePath) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { 
      encoding: 'utf8',
      start: 0,
      end: 1024, // Sample first 1KB
    });
    
    let content = '';
    
    stream.on('data', (chunk) => {
      content += chunk;
    });
    
    stream.on('end', () => {
      const trimmed = content.trim();
      // If starts with '[' it's a JSON array
      // If first non-whitespace is '{' it's likely NDJSON
      if (trimmed.startsWith('[')) {
        resolve('array');
      } else if (trimmed.startsWith('{')) {
        resolve('ndjson');
      } else {
        resolve('array'); // Default
      }
    });
    
    stream.on('error', reject);
  });
}

/**
 * Smart stream parse - auto-detects format
 * 
 * @param {string} filePath
 * @param {Object} options
 * @returns {Promise<Array|number>}
 */
async function streamParseJson(filePath, options = {}) {
  const format = await detectJsonFormat(filePath);
  
  if (format === 'ndjson') {
    return streamParseNdjson(filePath, options);
  }
  return streamParseJsonArray(filePath, options);
}

/**
 * Get file size in MB
 * @param {string} filePath
 * @returns {number}
 */
function getFileSizeMB(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return stats.size / (1024 * 1024);
  } catch {
    return 0;
  }
}

/**
 * Check if streaming should be used based on file size
 * @param {string} filePath
 * @param {number} thresholdMB - Size threshold in MB (default 20MB)
 * @returns {boolean}
 */
function shouldUseStreaming(filePath, thresholdMB = 20) {
  return getFileSizeMB(filePath) > thresholdMB;
}

/**
 * Load candles from cache file - uses streaming for large files
 * 
 * @param {string} filePath - Path to cache file
 * @param {Object} [options] - Options
 * @param {boolean} [options.useTypedArray=false] - Convert to TypedCandleArray
 * @param {number} [options.streamThresholdMB=20] - File size threshold for streaming
 * @returns {Promise<Array>} Array of candles
 */
async function loadCandlesFromCache(filePath, options = {}) {
  const {
    useTypedArray = false,
    streamThresholdMB = 20,
  } = options;

  if (!fs.existsSync(filePath)) {
    return null;
  }

  const useStreaming = shouldUseStreaming(filePath, streamThresholdMB);
  
  if (useStreaming) {
    console.log(`   📖 Streaming parse ${path.basename(filePath)} (${getFileSizeMB(filePath).toFixed(1)} MB)...`);
    const candles = await streamParseJson(filePath);
    
    if (useTypedArray) {
      const { createTypedCandleArray } = require('./typed-candle-array');
      return createTypedCandleArray(candles);
    }
    
    return candles;
  }
  
  // Small file - use standard JSON.parse
  const content = fs.readFileSync(filePath, 'utf8');
  const candles = JSON.parse(content);
  
  if (useTypedArray) {
    const { createTypedCandleArray } = require('./typed-candle-array');
    return createTypedCandleArray(candles);
  }
  
  return candles;
}

/**
 * Save candles to cache file
 * For large arrays, consider writing NDJSON for faster streaming reads
 * 
 * @param {string} filePath - Destination path
 * @param {Array} candles - Candles to save
 * @param {Object} [options] - Options
 * @param {boolean} [options.pretty=true] - Pretty print (slower to parse)
 */
async function saveCandlesToCache(filePath, candles, options = {}) {
  const { pretty = true } = options;
  
  // Ensure directory exists
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  // Convert TypedCandleArray to regular array if needed
  let data = candles;
  if (candles._typed) {
    data = candles.toObjectArray();
  }
  
  const content = pretty 
    ? JSON.stringify(data, null, 2)
    : JSON.stringify(data);
    
  fs.writeFileSync(filePath, content, 'utf8');
}

module.exports = {
  streamParseJsonArray,
  streamParseNdjson,
  streamParseJson,
  detectJsonFormat,
  shouldUseStreaming,
  getFileSizeMB,
  loadCandlesFromCache,
  saveCandlesToCache,
};

