import { readFileSync, watch } from 'fs';
import { logger } from './logging/logger.js';
import path from 'path';

let configCache = null;
let configPath = null;

export function initConfigLoader(projectRoot = process.cwd()) {
  configPath = path.resolve(projectRoot, 'config/risk-params.json');
  reloadConfig();
  
  // Setup file watcher for hot-reload
  watch(configPath, (eventType, filename) => {
    if (eventType === 'change') {
      logger.info('[config] Detected changes in risk-params.json, reloading...');
      reloadConfig();
    }
  });
}

function reloadConfig() {
  try {
    const configText = readFileSync(configPath, 'utf-8');
    configCache = JSON.parse(configText);
    logger.info('[config] Loaded risk parameters v' + configCache.version);
  } catch (error) {
    logger.error('[config] Failed to load risk parameters: ' + error.message);
    if (!configCache) {
      throw new Error('Critical: No valid configuration available');
    }
  }
}

export function getConfig() {
  if (!configCache) {
    throw new Error('Configuration not initialized. Call initConfigLoader() first.');
  }
  return configCache;
}
