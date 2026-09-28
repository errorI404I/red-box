import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { loadConfig,root } from './lib/config.js';
import { Store } from './lib/db.js';
import { Sagemcom } from './lib/router/sagemcom.js';
import { Telegram } from './lib/telegram.js';
import { Monitor } from './lib/monitor.js';
import { TelegramCommands } from './lib/telegram-commands.js';
import { tunnelUrl } from './lib/cloudflare.js';
const config=loadConfig(); mkdirSync(`${root}data`,{recursive:true,mode:0o700});
const store=new Store(`${root}data/red-box.sqlite`), router=new Sagemcom(config), telegram=new Telegram(config,store), monitor=new Monitor(config,router,store,telegram);
const commands=new TelegramCommands(config,store,telegram,monitor,root.replace(/\/$/,''));
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
async function body(req) { let text=''; for await (const chunk of req) { text+=chunk; if(text.length>4096) throw new Error('Solicitud demasiado grande'); } return JSON.parse(text); }
const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',"default-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  try {
    const path=new URL(req.url,'http://localhost').pathname;
    if (req.method !== 'GET') {
      const localProxy=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      const tunnelOrigin=localProxy?tunnelUrl(root.replace(/\/$/,'')):null;
      if (req.headers['content-type'] !== 'application/json' || (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== tunnelOrigin) || req.headers['sec-fetch-site'] === 'cross-site') return json(res,403,{error:'Origen o Content-Type inválido'});
    }
    if(req.method==='GET' && path==='/api/state') return json(res,200,{router:monitor.state,devices:store.devices(),events:store.events(),telegram:telegram.status(),cooldown:+(store.get('telegram.cooldown') || config.telegramCooldownSeconds)});
    if(req.method==='PATCH' && /^\/api\/devices\/\d+$/.test(path)) {
      const data=await body(req);
      if(typeof data.alias!=='string'||data.alias.length>100||typeof data.category!=='string'||data.category.length>100||typeof data.critical!=='boolean') return json(res,400,{error:'Datos inválidos'});
      return json(res,store.updateDevice(+path.split('/').pop(),data)?200:404,{ok:true});
    }
    if(req.method==='POST' && path==='/api/telegram/test') { await telegram.test();return json(res,200,{ok:true}); }
    if(req.method==='PATCH' && path==='/api/settings') {
      const {cooldown}=await body(req); if(!Number.isInteger(cooldown)||cooldown<1||cooldown>86400) return json(res,400,{error:'Cooldown: 1 a 86400 segundos'});
      store.set('telegram.cooldown',cooldown);return json(res,200,{ok:true});
    }
    const files={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/styles.css':['styles.css','text/css']};
    if(req.method==='GET' && files[path]) { const [file,type]=files[path];const content=await readFile(`${root}public/${file}`);res.writeHead(200,{'Content-Type':`${type}; charset=utf-8`});return res.end(content); }
    json(res,404,{error:'No encontrado'});
  } catch(e) { json(res,400,{error:e.message.startsWith('Telegram') || e.message.startsWith('Prueba') ? e.message : 'No se pudo procesar la solicitud'}); }
});
server.on('error', error => { console.error(JSON.stringify({name:error.name,code:error.code,message:'No se pudo iniciar el servidor HTTP'})); commands.stop(); monitor.stop(); router.close(); store.close(); process.exitCode=1; });
server.listen(config.port,config.host,()=>{console.log(`Red Box: http://${config.host}:${config.port}`);monitor.start();commands.start();});
async function shutdown() { commands.stop(); monitor.stop();server.close();router.close();while(monitor.running) await new Promise(r=>setTimeout(r,50));store.close(); }
process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
