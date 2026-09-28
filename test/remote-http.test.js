import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:net';
import {saveProcess} from '../lib/process-state.js';
const execute=promisify(execFile);
test('app inicia sin duplicar PID y acepta cambios desde el origen del túnel activo',async()=>{
 const root=mkdtempSync(join(tmpdir(),'red-box-http-')),source=fileURLToPath(new URL('../',import.meta.url));
 const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 for(const file of ['server.js','config.json','package.json','lib','public','scripts','start.sh','stop.sh'])cpSync(join(source,file),join(root,file),{recursive:true});
 const env={...process.env,PORT:String(port),ROUTER_URL:'https://127.0.0.1:1',TELEGRAM_BOT_TOKEN:'',TELEGRAM_CHAT_ID:''};delete env.NODE_TEST_CONTEXT;
 const command=name=>execute('bash',[join(root,name)],{cwd:root,env,timeout:20000});
 try{
  await command('start.sh');await command('start.sh');
  const url=`http://127.0.0.1:${port}`;const state=await(await fetch(url+'/api/state')).json();assert.ok(Array.isArray(state.devices));
  saveProcess(root,'cloudflared',process.pid);writeFileSync(join(root,'data/cloudflare-url.txt'),'https://test-session.trycloudflare.com');
  const change=origin=>fetch(url+'/api/settings',{method:'PATCH',headers:{'Content-Type':'application/json',Origin:origin},body:'{"cooldown":120}'});
  assert.equal((await change('https://test-session.trycloudflare.com')).status,200);
  assert.equal((await change('https://other.trycloudflare.com')).status,403);
  assert.equal((await change('https://example.invalid')).status,403);
 }finally{try{await command('stop.sh');}finally{rmSync(root,{recursive:true,force:true});}}
});
