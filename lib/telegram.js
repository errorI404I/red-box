import { createHash } from 'node:crypto';
export class Telegram {
  constructor(config, store, fetcher = fetch) { this.config=config; this.store=store; this.fetcher=fetcher; this.busy=false; }
  fingerprint() { return createHash('sha256').update(`${this.config.token}:${this.config.chatId}`).digest('hex'); }
  status() { return !this.config.token || !this.config.chatId ? 'no configurado' : this.store.get('telegram.validated') === this.fingerprint() ? 'validado' : 'configurado'; }
  async send(text) {
    if (this.status() === 'no configurado') throw new Error('Telegram no configurado');
    let res;
    try { res = await this.fetcher(`https://api.telegram.org/bot${this.config.token}/sendMessage`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({chat_id:this.config.chatId,text}), signal:AbortSignal.timeout(this.config.timeoutSeconds*1000) }); }
    catch { throw new Error('Telegram: fallo de conexión o timeout'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok !== true) {
      const description = String(data.description || 'Respuesta inválida').split(this.config.token).join('[REDACTADO]');
      throw new Error(`Telegram HTTP ${res.status}: ${description}`);
    }
  }
  async test() {
    if (this.busy) throw new Error('Prueba Telegram en curso');
    this.busy=true;
    try { await this.send('Red Box: Telegram funcionando correctamente.'); this.store.set('telegram.validated',this.fingerprint()); }
    catch(e) { this.store.set('telegram.validated',''); throw e; }
    finally { this.busy=false; }
  }
  async alert(key, message, now = Date.now()) {
    if (this.status() !== 'validado') return false;
    const cooldown = +(this.store.get('telegram.cooldown') || this.config.telegramCooldownSeconds)*1000;
    const previous = this.store.get(`cooldown:${key}`);
    if (previous && now - +previous < cooldown) return false;
    // Failed sends are also throttled; validation remains required after credential changes.
    this.store.set(`cooldown:${key}`,now);
    await this.send(`Red Box: ${message}`); return true;
  }
}
