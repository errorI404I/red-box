import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,cpSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {parseTunnelUrl,tunnelUrl} from '../lib/cloudflare.js';
import {saveProcess,managedProcess,lock} from '../lib/process-state.js';
import {TelegramCommands} from '../lib/telegram-commands.js';
import {Telegram} from '../lib/telegram.js';
import {updateProject,recoverUpdate,resultMessage} from '../lib/update.js';
const execute=promisify(execFile);
const source=fileURLToPath(new URL('../',import.meta.url));
function project(t){const root=mkdtempSync(join(tmpdir(),'red-box-remote-'));mkdirSync(join(root,'data'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
function bot(t,extra={}){
 const root=project(t),sent=[],values=new Map();const store={get:k=>values.get(k),set:(k,v)=>values.set(k,String(v))};
 const telegram={send:async message=>sent.push(message),fingerprint:()=> 'test',status:()=> 'configurado'};
 const commands=new TelegramCommands({chatId:'123'},store,telegram,{state:{status:'conectado',count:2}},root,extra);
 return {root,sent,store,commands};
}
const message=(text,id=123)=>({message:{chat:{id},text}});
test('parser acepta solamente URLs trycloudflare completas',()=>{
 assert.equal(parseTunnelUrl('| https://red-box-one.trycloudflare.com |'),'https://red-box-one.trycloudflare.com');
 for(const value of ['https://x.trycloudflare.com.evil.org','https://x.trycloudflare.com/path','http://x.trycloudflare.com','https://x.trycloudflare.com?token=secret','https://evil.org','https://-x.trycloudflare.com'])assert.equal(parseTunnelUrl(value),null);
});
test('/url con archivo y PID verificados; sin archivo o sin proceso activo',async t=>{
 const {root,sent,commands}=bot(t);saveProcess(root,'cloudflared',process.pid);
 writeFileSync(join(root,'data/cloudflare-url.txt'),'https://sample.trycloudflare.com\n');
 await commands.handle(message('/url'));assert.equal(sent.pop(),'Red Box:\nhttps://sample.trycloudflare.com');
 rmSync(join(root,'data/cloudflare-url.txt'));await commands.handle(message('/url'));assert.equal(sent.pop(),'Red Box no tiene un túnel Cloudflare activo.');
 writeFileSync(join(root,'data/cloudflare-url.txt'),'https://sample.trycloudflare.com');writeFileSync(join(root,'data/cloudflared.pid'),'999999999');assert.equal(tunnelUrl(root),null);
});
test('otros chats y comandos arbitrarios no ejecutan ni responden',async t=>{
 let launches=0;const {commands,sent}=bot(t,{startUpdate:async()=>{launches++;}});
 for(const text of ['/url','/status','/update'])await commands.handle(message(text,999));
 for(const text of ['/exec ls','/shell','/bash','/cmd','/update; rm -rf /'])await commands.handle(message(text));
 assert.equal(launches,0);assert.deepEqual(sent,[]);
 for(const text of ['/update main','/update $(id)','/update\nsecret'])await commands.handle(message(text));
 assert.equal(launches,0);assert.ok(sent.every(s=>s==='Usá /update sin argumentos.'));
});
test('/update lanza acción fija una sola vez; /status no filtra datos privados',async t=>{
 let launches=0;const {commands,sent}=bot(t,{startUpdate:async(...args)=>{assert.deepEqual(args,[]);launches++;}});
 await commands.handle(message('/update'));await commands.handle(message('/update'));assert.equal(launches,1);
 assert.equal(sent[0],'Actualizando Red Box...');
 commands.monitor.state.error={message:'ROUTER_PASSWORD=secret'};
 await commands.handle(message('/status'));assert.ok(!sent.at(-1).includes('secret'));assert.match(sent.at(-1),/Dispositivos: 2/);
});
test('resultado fallido no anuncia éxito; éxito informa commit y solo una vez',async t=>{
 const {root,commands,sent}=bot(t);
 writeFileSync(join(root,'data/update-result.json'),JSON.stringify({id:'1',state:'failed',stage:'tests',restored:true,error:'TOKEN_SECRET'}));
 await commands.reportResult();assert.match(sent[0],/falló/);assert.ok(!sent[0].includes('TOKEN_SECRET'));
 writeFileSync(join(root,'data/update-result.json'),JSON.stringify({id:'2',state:'success',commit:'a'.repeat(40)}));
 await commands.reportResult();await commands.reportResult();assert.equal(sent.length,2);assert.match(sent[1],/Commit: aaaaaaa/);
 assert.match(resultMessage({state:'success',commit:'secret-token'}),/falló/);
});
test('getUpdates usa solo mensajes y no expone token en errores',async()=>{
 const controller=new AbortController();const telegram=new Telegram({token:'secret',chatId:'123'}, {},async(url,options)=>{
 assert.deepEqual(JSON.parse(options.body),{offset:12,timeout:20,allowed_updates:['message']});return {ok:false,json:async()=>({description:'secret'})};});
 await assert.rejects(telegram.updates(12,20,controller.signal),e=>!e.message.includes('secret'));
});
test('PID inválido o reutilizado se rechaza; lock evita duplicados',t=>{
 const root=project(t);saveProcess(root,'cloudflared',process.pid);assert.equal(managedProcess(root,'cloudflared').pid,process.pid);
 const path=join(root,'data/cloudflared-state.json'),saved=JSON.parse(readFileSync(path));saved.start='invalid';writeFileSync(path,JSON.stringify(saved));assert.throws(()=>managedProcess(root,'cloudflared'),/otro proceso/);
 writeFileSync(join(root,'data/cloudflared.pid'),'1; kill -9');assert.throws(()=>managedProcess(root,'cloudflared'),/PID inválido/);
 const release=lock(join(root,'data/test.lock'));assert.throws(()=>lock(join(root,'data/test.lock')),/curso/);release();lock(join(root,'data/test.lock'))();
});
for(const failAt of ['tests','reinicio',null])test(`update ${failAt||'exitoso'} protege privados y restaura si corresponde`,async t=>{
 const root=project(t),calls=[];const previous='a'.repeat(40),target='b'.repeat(40);let startCalls=0;
 writeFileSync(join(root,'.env'),'SECRET_DO_NOT_LOG');writeFileSync(join(root,'data/keep'),'private');
 const run=async(command,args,options)=>{
  calls.push([command,...args]);
  if(command==='git'&&args[0]==='status')return '';
  if(command==='git'&&args[0]==='branch')return 'master';
  if(command==='git'&&args[0]==='ls-remote')return `${target}\trefs/heads/master\n`;
  if(command==='git'&&args.includes('check-ignore'))return '.env\ndata/__red_box_probe__\n';
  if(command==='git'&&args[0]==='ls-files')return 'server.js\n';
  if(command==='git'&&args[0]==='ls-tree')return 'server.js\n';
  if(command==='git'&&args[0]==='rev-parse')return args.includes('HEAD')?previous:target;
  if(command==='npm'&&args[0]==='test'&&failAt==='tests')throw new Error('TOKEN_SECRET npm failure');
  if(command==='bash'&&args[0].endsWith('/start.sh')&&failAt==='reinicio'&&startCalls++===0)throw new Error('restart failed');
  return '';
 };
 await updateProject(root,{run,health:async()=>{},verifyProcess:()=>({pid:1})});
 const result=JSON.parse(readFileSync(join(root,'data/update-result.json'),'utf8'));
 assert.equal(result.state,failAt?'failed':'success');
 if(failAt==='tests')assert.ok(!calls.some(c=>c.includes('--hard')));
 if(failAt==='reinicio'){assert.ok(calls.some(c=>c.includes('--hard')&&c.includes(previous)));assert.equal(result.restored,true);}
 if(!failAt)assert.equal(result.commit,target);
 assert.equal(readFileSync(join(root,'.env'),'utf8'),'SECRET_DO_NOT_LOG');assert.equal(readFileSync(join(root,'data/keep'),'utf8'),'private');
 assert.ok(!readFileSync(join(root,'data/update.log'),'utf8').includes('SECRET'));
});
test('scripts Cloudflare: inicia una vez, reemplaza URL, detiene solo el PID propio',async t=>{
 const root=project(t);for(const name of ['lib','scripts'])cpSync(join(source,name),join(root,name),{recursive:true});writeFileSync(join(root,'package.json'),'{"type":"module"}');
 const bin=join(root,'bin');mkdirSync(bin);
 writeFileSync(join(bin,'cloudflared'), '#!/usr/bin/env bash\necho "https://fresh-session.trycloudflare.com"\ntrap "exit 0" TERM\nwhile true; do sleep 0.1; done\n',{mode:0o700});
 const env={...process.env,PATH:`${bin}:${process.env.PATH}`};delete env.NODE_TEST_CONTEXT;
 const command=action=>execute('bash',[join(root,`scripts/${action}-cloudflare.sh`)],{env,timeout:15000});
 t.after(async()=>{try{await command('stop');}catch{}});
 writeFileSync(join(root,'data/cloudflare-url.txt'),'https://old.trycloudflare.com');
 await command('start');const pid=readFileSync(join(root,'data/cloudflared.pid'),'utf8');
 await command('start');assert.equal(readFileSync(join(root,'data/cloudflared.pid'),'utf8'),pid);
 assert.equal(readFileSync(join(root,'data/cloudflare-url.txt'),'utf8').trim(),'https://fresh-session.trycloudflare.com');
 await command('stop');assert.ok(!existsSync(join(root,'data/cloudflared.pid')));assert.ok(!existsSync(join(root,'data/cloudflare-url.txt')));
});

test('update rechaza .env/data versionados antes de tocar el working tree',async t=>{
 const root=project(t),calls=[];
 await updateProject(root,{verifyProcess:()=>true,run:async(command,args)=>{
  calls.push(args);if(args[0]==='status')return '';if(args[0]==='ls-files')return '.env\nserver.js';return '';
 }});
 const result=JSON.parse(readFileSync(join(root,'data/update-result.json')));
 assert.equal(result.state,'failed');assert.equal(result.stage,'preparación');assert.ok(!calls.some(args=>args.includes('--hard')));
});

test('update con Git real: candidato probado antes de reset y archivos privados conservados',async t=>{
 const root=project(t);const env={...process.env,GIT_AUTHOR_NAME:'Test',GIT_AUTHOR_EMAIL:'test@example.invalid',GIT_COMMITTER_NAME:'Test',GIT_COMMITTER_EMAIL:'test@example.invalid'};delete env.NODE_TEST_CONTEXT;
 const git=async args=>(await execute('git',args,{cwd:root,env})).stdout;
 await git(['init','-b','master']);
 writeFileSync(join(root,'.gitignore'),'.env\ndata/\nnode_modules/\n');
 writeFileSync(join(root,'package.json'),JSON.stringify({name:'update-fixture',version:'1.0.0',scripts:{test:'node -e "process.exit(0)"'}}));
 mkdirSync(join(root,'scripts'));for(const file of ['start.sh','stop.sh'])writeFileSync(join(root,file),'#!/usr/bin/env bash\nexit 0\n');
 writeFileSync(join(root,'version.txt'),'old');await git(['add','.']);await git(['commit','-m','old']);const previous=(await git(['rev-parse','HEAD'])).trim();
 writeFileSync(join(root,'version.txt'),'new');await git(['add','.']);await git(['commit','-m','new']);const target=(await git(['rev-parse','HEAD'])).trim();
 const remote=join(root,'data/origin.git');await git(['clone','--bare',root,remote]);
 await git(['reset','--hard',previous]);await git(['remote','add','origin',remote]);
 writeFileSync(join(root,'.env'),'DO_NOT_DELETE');writeFileSync(join(root,'data/private'),'KEEP');
 await updateProject(root,{verifyProcess:()=>true,health:async()=>{}});
 const result=JSON.parse(readFileSync(join(root,'data/update-result.json')));
 assert.equal(result.state,'success');assert.equal(result.commit,target);assert.equal((await git(['rev-parse','HEAD'])).trim(),target);
 assert.equal(readFileSync(join(root,'.env'),'utf8'),'DO_NOT_DELETE');assert.equal(readFileSync(join(root,'data/private'),'utf8'),'KEEP');
});

test('recuperación tras interrupción restaura commit y dependencias anteriores',async t=>{
 const root=project(t),id='11111111-1111-1111-1111-111111111111',previous='a'.repeat(40),target='b'.repeat(40);
 const work=join(root,'data',`update-${id}`);mkdirSync(join(work,'old-node_modules'),{recursive:true});writeFileSync(join(work,'old-node_modules/version'),'old');mkdirSync(join(root,'node_modules'));writeFileSync(join(root,'node_modules/version'),'new');
 writeFileSync(join(root,'data/update-journal.json'),JSON.stringify({id,previous,target,hadModules:true}));
 const calls=[];let active=false;
 await recoverUpdate(root,{verifyProcess:()=>active,health:async()=>{},run:async(command,args)=>{calls.push([command,...args]);if(args[0]==='rev-parse')return target;if(args[0]?.endsWith('/start.sh'))active=true;return '';}});
 assert.ok(calls.some(c=>c.includes('--hard')&&c.includes(previous)));
 assert.equal(readFileSync(join(root,'node_modules/version'),'utf8'),'old');
 assert.ok(!existsSync(join(root,'data/update-journal.json')));
 const result=JSON.parse(readFileSync(join(root,'data/update-result.json')));assert.equal(result.state,'failed');assert.equal(result.restored,true);
});

test('long polling descarta cola antigua y persiste offset antes de /update',async t=>{
 let launches=0;const {commands,store}=bot(t,{startUpdate:async()=>{assert.equal(store.get(commands.offsetKey),'12');launches++;}});
 commands.controller=new AbortController();commands.stopped=false;
 commands.telegram.updates=async(offset)=>offset===-1?[{update_id:10,...message('/update')}]:[{update_id:11,...message('/update')}];
 await commands.poll();assert.equal(launches,0);assert.equal(store.get(commands.offsetKey),'11');
 await commands.poll();assert.equal(launches,1);await commands.poll();assert.equal(launches,1);
 commands.stop();
});
