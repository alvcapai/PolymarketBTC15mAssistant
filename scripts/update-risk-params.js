#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';

const configPath = path.resolve(process.cwd(), 'config/risk-params.json');

function updateRiskParams(updates) {
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    
    // Deep merge updates
    for (const [section, params] of Object.entries(updates)) {
      if (config[section]) {
        Object.assign(config[section], params);
      }
    }
    
    // Increment version
    const version = config.version.split('.').map(Number);
    version[2]++;
    config.version = version.join('.');
    
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log('✓ Updated risk parameters to v' + config.version);
    console.log('Changes applied:', JSON.stringify(updates, null, 2));
  } catch (error) {
    console.error('✗ Error updating risk parameters:', error.message);
    process.exit(1);
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
if (args.length === 0) {
  console.log('Usage: node scripts/update-risk-params.js <section.param=value> ...');
  console.log('Example: node scripts/update-risk-params.js limits.max_stake_pct=0.12 bankroll.risk_cap=0.18');
  process.exit(1);
}

const updates = {};
for (const arg of args) {
  const [key, value] = arg.split('=');
  const [section, param] = key.split('.');
  
  if (!updates[section]) updates[section] = {};
  updates[section][param] = isNaN(value) ? value : Number(value);
}

updateRiskParams(updates);
