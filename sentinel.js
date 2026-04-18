import fs from 'fs';
import path from 'path';

const LOG_DIR = './logs';
const CHECK_INTERVAL = 60000;
const DISCORD_WEBHOOK = process.env.SENTINEL_WEBHOOK;

let lastPositions = {};

function logger(msg) {
  console.log('[' + new Date().toISOString() + '] SENTINEL: ' + msg);
}

async function notify(msg) {
  logger(msg);
  if (DISCORD_WEBHOOK) {
    try {
      await fetch(DISCORD_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '🚨 **SENTINEL ALERT** 🚨\n' + msg })
      });
    } catch (e) { logger('Erro ao enviar webhook: ' + e.message); }
  }
}

function checkLogs() {
  if (!fs.existsSync(LOG_DIR)) return;
  const files = fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.log'));
  
  files.forEach(file => {
    const filePath = path.join(LOG_DIR, file);
    const stats = fs.statSync(filePath);
    const currentSize = stats.size;
    const lastSize = lastPositions[file] || 0;

    if (currentSize > lastSize) {
      const fd = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(currentSize - lastSize);
      fs.readSync(fd, buffer, 0, currentSize - lastSize, lastSize);
      fs.closeSync(fd);
      
      const chunk = buffer.toString();
      if (chunk.includes('FALHA') || chunk.includes('ERROR') || chunk.includes('TypeError') || chunk.includes('invalid fee')) {
        notify('Erro detectado em ' + file + ':\n' + chunk.substring(0, 500));
      }
      if (chunk.includes('SAQUE AUTOMÁTICO EXECUTADO')) {
        notify('💰 **MONACO RULE ATIVADA!** Saque realizado com sucesso.');
      }
    }
    lastPositions[file] = currentSize;
  });
}

logger('Iniciando estagiário sentinela...');
setInterval(checkLogs, CHECK_INTERVAL);
if (fs.existsSync(LOG_DIR)) {
  fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.log')).forEach(f => {
    lastPositions[f] = fs.statSync(path.join(LOG_DIR, f)).size;
  });
}
