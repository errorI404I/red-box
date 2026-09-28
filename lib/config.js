import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export const root = fileURLToPath(new URL('../', import.meta.url));
export function loadConfig() {
  if (existsSync(`${root}.env`)) process.loadEnvFile(`${root}.env`);
  const options = JSON.parse(readFileSync(`${root}config.json`, 'utf8'));
  options.port = Number(process.env.PORT) || Number(options.port) || 8080;
  options.host = options.host || '0.0.0.0';
  for (const key of ['port', 'pollSeconds', 'timeoutSeconds', 'routerFailureCycles', 'telegramCooldownSeconds']) {
    if (!Number.isInteger(options[key]) || options[key] < 1) throw new Error(`Configuración inválida: ${key}`);
  }
  const routerUrl = new URL(process.env.ROUTER_URL || 'https://192.168.0.1');
  if (routerUrl.protocol !== 'https:' || routerUrl.username || routerUrl.password) throw new Error('ROUTER_URL debe ser HTTPS sin credenciales');
  return { ...options, routerUrl: routerUrl.origin, username: process.env.ROUTER_USERNAME || 'custadmin', password: process.env.ROUTER_PASSWORD || '', token: process.env.TELEGRAM_BOT_TOKEN || '', chatId: process.env.TELEGRAM_CHAT_ID || '' };
}
