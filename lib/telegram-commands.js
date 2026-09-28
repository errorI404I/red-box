import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tunnelUrl } from './cloudflare.js';
import { resultMessage } from './update.js';
import { identity, safeEnvironment } from './process-state.js';
export function launchUpdate(root) {
  return new Promise((resolve,reject)=>{
    const resultPath=join(root,'data/update-result.json');
    let previous;try{previous=readFileSync(resultPath,'utf8');}catch{}
    const child=spawn('bash',[join(root,'scripts/update.sh')],{cwd:root,env:safeEnvironment(),detached:true,stdio:'ignore'});
    let done=false;
    const finish=ok=>{if(done)return;done=true;clearInterval(poll);clearTimeout(timer);ok?resolve():reject(new Error('No se pudo iniciar la actualización'));};
    const poll=setInterval(()=>{
      try{const owner=JSON.parse(readFileSync(join(root,'data/update.lock'),'utf8'));if(identity(owner.pid)?.start===owner.start)finish(true);}catch{}
    },100);
    const timer=setTimeout(()=>finish(false),5000);
    child.once('error',()=>finish(false));
    child.once('spawn',()=>child.unref());
    child.once('exit',code=>{let changed=false;try{changed=readFileSync(resultPath,'utf8')!==previous;}catch{}finish(code===0&&changed);});
  });
}
export class TelegramCommands {
  constructor(config,store,telegram,monitor,root,{getUrl=()=>tunnelUrl(root),startUpdate=()=>launchUpdate(root),log=console.error}={}) {
    Object.assign(this,{config,store,telegram,monitor,root,getUrl,startUpdate,log});
    this.stopped=true;this.launching=false;
    this.offsetKey=`telegram.offset:${telegram.fingerprint()}`;
  }
  updateBusy() {
    try{const owner=JSON.parse(readFileSync(join(this.root,'data/update.lock'),'utf8'));return identity(owner.pid)?.start===owner.start;}catch{return false;}
  }
  async handle(update) {
    const message=update?.message;
    if(!message || String(message.chat?.id)!==this.config.chatId || message.forward_origin || typeof message.text!=='string')return;
    const text=message.text.trim();
    const match=text.match(/^\/(url|status|update)(?:@[a-z0-9_]+)?$/i);
    if(!match){if(/^\/update(?:\s|@)/i.test(text))await this.telegram.send('Usá /update sin argumentos.');return;}
    const command=match[1].toLowerCase();
    if(command==='url'){const url=this.getUrl();await this.telegram.send(url?`Red Box:\n${url}`:'Red Box no tiene un túnel Cloudflare activo.');return;}
    if(command==='status'){
      const url=this.getUrl(),state=this.monitor.state;
      const router=['conectado','error','pendiente'].includes(state.status)?state.status:'pendiente';
      await this.telegram.send(`Red Box: online\nRouter: ${router}\nDispositivos: ${Number.isInteger(state.count)?state.count:'sin datos'}\nCloudflare: ${url?'activo':'inactivo'}${url?`\nURL: ${url}`:''}`);return;
    }
    if(this.launching||this.updateBusy()){await this.telegram.send('Ya hay una actualización de Red Box en curso.');return;}
    this.launching=true;
    try {await this.telegram.send('Actualizando Red Box...');await this.startUpdate();}
    catch{await this.telegram.send('La actualización de Red Box no pudo iniciarse. Revisar data/update.log.');this.launching=false;}
  }
  async reportResult() {
    let result;try{const raw=readFileSync(join(this.root,'data/update-result.json'),'utf8');if(raw.length>4096)return;result=JSON.parse(raw);}catch{return;}
    if(!['success','failed'].includes(result.state)||typeof result.id!=='string'||this.updateBusy())return;
    if(this.store.get('telegram.update-notified')===result.id){this.launching=false;return;}
    await this.telegram.send(resultMessage(result));
    this.store.set('telegram.update-notified',result.id);this.launching=false;
  }
  async poll() {
    await this.reportResult();
    let offset=this.store.get(this.offsetKey);
    if(offset===undefined){
      // Discard pending old commands on first setup; never replay an old /update.
      const backlog=await this.telegram.updates(-1,0,this.controller.signal);
      offset=String(backlog.length?Math.max(...backlog.map(u=>u.update_id))+1:0);
      this.store.set(this.offsetKey,offset);return;
    }
    const updates=await this.telegram.updates(Number(offset),20,this.controller.signal);
    for(const update of updates){
      if(this.stopped)break;
      if(!Number.isSafeInteger(update.update_id)||update.update_id<Number(this.store.get(this.offsetKey)))continue;
      // Persist before executing: a restart must not repeat a destructive command.
      this.store.set(this.offsetKey,update.update_id+1);
      await this.handle(update);
    }
  }
  start() {
    if(this.telegram.status()==='no configurado'||!this.stopped)return;
    mkdirSync(join(this.root,'data'),{recursive:true,mode:0o700});
    this.stopped=false;this.controller=new AbortController();
    const tick=async()=>{let delay=1000;try{await this.poll();}catch{delay=5000;if(!this.stopped)this.log('Telegram comandos: fallo de consulta o envío; se reintentará.');}finally{if(!this.stopped)this.timer=setTimeout(tick,delay);}};
    void tick();
  }
  stop(){this.stopped=true;clearTimeout(this.timer);this.controller?.abort();}
}
