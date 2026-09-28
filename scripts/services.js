import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, unlinkSync, appendFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { lock, identity, managedProcess, saveProcess, cleanProcess, safeEnvironment } from '../lib/process-state.js';
import { parseTunnelUrl, tunnelUrl } from '../lib/cloudflare.js';
const root=fileURLToPath(new URL('../',import.meta.url)).replace(/\/$/,'');
const [service,action]=process.argv.slice(2);
if(!['app','cloudflare'].includes(service)||!['start','stop'].includes(action)){console.error('Uso: services.js app|cloudflare start|stop');process.exit(1);}
const name=service==='app'?'red-box':'cloudflared', log=join(root,'data',`${name}.log`);
mkdirSync(join(root,'data'),{recursive:true,mode:0o700});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const clearUrl=()=>{if(service==='cloudflare')try{unlinkSync(join(root,'data/cloudflare-url.txt'));}catch{}};
async function stop() {
  const active=managedProcess(root,name);
  if(active){
    process.kill(active.pid,'SIGTERM');
    for(let i=0;i<100&&identity(active.pid)?.start===active.start;i++)await delay(100);
    if(identity(active.pid)?.start===active.start)throw new Error('El proceso no terminó; se conserva su PID');
  }
  cleanProcess(root,name);clearUrl();
}
async function start() {
  if(managedProcess(root,name)){
    if(service==='cloudflare'&&!tunnelUrl(root))throw new Error('Túnel en ejecución sin URL válida; revisar log o detenerlo antes de reintentar');
    console.log(`${name} ya está activo`);return;
  }
  cleanProcess(root,name);clearUrl();
  // New tunnel logs replace old logs so a URL from a previous session cannot leak through.
  if(service==='cloudflare')writeFileSync(log,'',{mode:0o600});
  const fd=openSync(log,'a',0o600);
  const env=service==='cloudflare'?safeEnvironment():{...process.env};
  // Quick Tunnel must not load a named tunnel, token or config from the user's HOME.
  if(service==='cloudflare'){env.HOME=join(root,'data/cloudflare-home');mkdirSync(env.HOME,{recursive:true,mode:0o700});}
  let child;
  try {
    child=spawn(service==='app'?process.execPath:'cloudflared',service==='app'?[join(root,'server.js')]:['tunnel','--url','http://127.0.0.1:8080'],{cwd:root,env,detached:true,stdio:['ignore',fd,fd]});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>reject(new Error(`${name} no está instalado o no pudo ejecutarse`)));});
  }finally{closeSync(fd);}
  child.unref();
  await delay(100);
  try {
    saveProcess(root,name,child.pid);
    if(service==='app'){await delay(900);if(!managedProcess(root,name))throw new Error('Red Box no inició; revisar data/red-box.log');console.log('Red Box iniciado');return;}
    for(let i=0;i<60;i++){
      if(!managedProcess(root,name))throw new Error('cloudflared terminó antes de obtener una URL');
      const url=parseTunnelUrl(readFileSync(log,'utf8'));
      if(url){const path=join(root,'data/cloudflare-url.txt');writeFileSync(`${path}.tmp`,url+'\n',{mode:0o600});renameSync(`${path}.tmp`,path);console.log(url);return;}
      await delay(1000);
    }
    throw new Error('No apareció una URL trycloudflare en 60 segundos; verificar red y compatibilidad de cloudflared');
  }catch(e){try{await stop();}catch{}throw e;}
}
let release;
try{release=lock(join(root,'data',`${name}.lock`));await (action==='start'?start():stop());}
catch(e){const message=`${new Date().toISOString()} ${e.message}`;appendFileSync(log,message+'\n',{mode:0o600});console.error(message);process.exitCode=1;}
finally{release?.();}
