import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { managedProcess } from './process-state.js';
export function parseTunnelUrl(text) {
  return text.match(/https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com(?=$|[\s"'<>|])/i)?.[0]?.toLowerCase() || null;
}
export function tunnelUrl(root) {
  try {
    if(!managedProcess(root,'cloudflared'))return null;
    const value=readFileSync(join(root,'data/cloudflare-url.txt'),'utf8').trim();
    return parseTunnelUrl(value)===value?value:null;
  }catch{return null;}
}
