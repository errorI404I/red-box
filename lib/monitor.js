export class Monitor {
  constructor(config, router, store, telegram) {
    Object.assign(this,{config,router,store,telegram});
    this.state={status:'pendiente',lastQuery:null,lastSuccess:null,count:null,failures:0,error:null};
    this.running=false; this.stopped=true; this.unavailable=false;
  }
  async notify(key,message) { try { await this.telegram.alert(key,message); } catch(e) { console.error(e.message); } }
  async poll() {
    if (this.running) return;
    this.running=true; this.state.lastQuery=new Date().toISOString();
    try {
      let changes;
      try {
        const devices=await this.router.devices(); changes=this.store.apply(devices);
        Object.assign(this.state,{status:'conectado',lastSuccess:new Date().toISOString(),count:devices.length,failures:0,error:null});
      } catch(e) {
        this.state.failures++; this.state.status='error'; this.state.error=this.router.diagnostic(e);
        console.error(JSON.stringify(this.state.error));
        if (this.state.failures >= this.config.routerFailureCycles && !this.unavailable) {
          this.unavailable=true; this.store.event('router_down','Router no disponible');
          await this.notify('router_down','Router no disponible');
        }
        return;
      }
      if (this.unavailable) { this.unavailable=false; this.store.event('router_up','Router recuperado'); await this.notify('router_up','Router recuperado'); }
      for (const change of changes) if (change.type === 'new' || (change.device.critical && ['offline','online'].includes(change.type))) await this.notify(`${change.type}:${change.device.id}`,change.message);
    } finally { this.running=false; }
  }
  start() { this.stopped=false; const tick=async()=>{ try { await this.poll(); } catch(e) { console.error('Monitor:',e.name,e.code || '', 'Error interno'); } finally { if(!this.stopped) this.timer=setTimeout(tick,this.config.pollSeconds*1000); } }; void tick(); }
  stop() { this.stopped=true; clearTimeout(this.timer); }
}
