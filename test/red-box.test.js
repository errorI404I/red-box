import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Sagemcom, parseDevices, encodePassword } from '../lib/router/sagemcom.js';
import { Store } from '../lib/db.js';
import { Telegram } from '../lib/telegram.js';
import { Monitor } from '../lib/monitor.js';
const fixture=name=>readFileSync(new URL(`fixtures/${name}.html`,import.meta.url),'utf8');
const config={routerUrl:'https://192.168.0.1',username:'custadmin',password:'á-secret',timeoutSeconds:1,token:'secret-token',chatId:'123',telegramCooldownSeconds:300,routerFailureCycles:3,pollSeconds:60};
const response=(status,body='',headers={})=>({status,body,headers});
const cookies={'set-cookie':['PHPSESSID=session-value; Path=/','csrfp_token=token-value; Path=/']};
function client(responses, calls=[]) { return new Sagemcom(config,{log:()=>{},request:async(path,options)=>{calls.push({path,...options});return responses.shift();}}); }
test('Base64 UTF-8',()=>assert.equal(encodePassword('contraseña'),Buffer.from('contraseña','utf8').toString('base64')));
test('cookies, form y login 302',async()=>{
 const calls=[];const c=client([response(200,'',cookies),response(302,'',{location:'main.php'}),response(200,fixture('devices'))],calls);
 assert.equal((await c.devices()).length,2);assert.equal(calls[1].headers.Cookie,'PHPSESSID=session-value; csrfp_token=token-value');const body=new URLSearchParams(calls[1].body);assert.equal(body.get('password'),encodePassword(config.password));assert.equal(body.get('csrfp_token'),'token-value');c.close();
});
test('login incorrecto, cookie faltante y token faltante',async()=>{
 for(const [responses,code] of [[[response(200)],'COOKIES_MISSING'],[[response(200,'',{'set-cookie':['PHPSESSID=x']})],'TOKEN_MISSING'],[[response(200,'',cookies),response(200)],'LOGIN']]){const c=client(responses);await assert.rejects(c.login(),{code});c.close();}
});
test('sesión expirada: solo una reautenticación',async()=>{
 const calls=[];const c=client([response(200,'',cookies),response(302,'',{location:'main.php'}),response(200,fixture('login')),response(200,'',cookies),response(302,'',{location:'main.php'}),response(302,'',{location:'index.php'})],calls);
 await assert.rejects(c.devices(),{code:'SESSION_EXPIRED'});assert.equal(calls.filter(c=>c.path==='/check.php').length,2);c.close();
});
test('sesión recuperada',async()=>{const c=client([response(200,'',cookies),response(302,'',{location:'main.php'}),response(401),response(200,'',cookies),response(302,'',{location:'main.php'}),response(200,fixture('empty'))]);assert.deepEqual(await c.devices(),[]);c.close();});
test('parser campos reales, vacío válido y HTML inesperado',()=>{
 assert.deepEqual(parseDevices(fixture('devices'))[0],{hostname:'omarchy',ip:'192.168.0.30',mac:'A0:59:50:CE:18:05',connection:'Wi-Fi 2.4G',rssi:-34,assignment:'DHCP',online:true});
 assert.equal(parseDevices(fixture('devices'))[1].hostname,'TV & Audio');assert.deepEqual(parseDevices(fixture('empty')),[]);assert.throws(()=>parseDevices('<html>Error</html>'),{code:'HTML_UNEXPECTED'});assert.throws(()=>parseDevices(fixture('devices').replace('= 2;','= 3;')),{code:'PARSER'});
});
test('SQLite: nuevo, sin eventos por polling/RSSI, IP, offline y recovery',()=>{
 const s=new Store(':memory:');const devices=parseDevices(fixture('devices'));assert.equal(s.apply(devices).length,2);assert.equal(s.apply(devices).length,0);devices[0].rssi--;assert.equal(s.apply(devices).length,0);devices[0].ip='192.168.0.90';assert.deepEqual(s.apply(devices).map(e=>e.type),['ip']);assert.equal(s.apply([]).length,2);assert.deepEqual(s.apply(devices).map(e=>e.type),['online','online']);assert.equal(s.devices().length,2);s.close();
});
test('Telegram prueba, validación, cooldown y cambio de credenciales',async()=>{
 const s=new Store(':memory:');const sent=[];const t=new Telegram(config,s,async(url,options)=>{sent.push(JSON.parse(options.body).text);return {ok:true,status:200,json:async()=>({ok:true})};});
 assert.equal(await t.alert('x','mensaje'),false);await t.test();assert.equal(sent[0],'Red Box: Telegram funcionando correctamente.');assert.equal(t.status(),'validado');assert.equal(await t.alert('x','nuevo',1000000),true);assert.equal(await t.alert('x','nuevo',1000001),false);assert.equal(await t.alert('x','nuevo',1300000),true);const other=new Telegram({...config,token:'changed'},s);assert.equal(other.status(),'configurado');s.close();
});
test('Telegram error HTTP visible y no valida',async()=>{const s=new Store(':memory:');const t=new Telegram(config,s,async()=>({ok:false,status:400,json:async()=>({ok:false,description:'chat not found'})}));await assert.rejects(t.test(),/HTTP 400: chat not found/);assert.equal(t.status(),'configurado');s.close();});
test('fallos preservan dispositivos; router down/up y críticos',async()=>{
 const s=new Store(':memory:');let fail=false;let devices=parseDevices(fixture('devices'));const sent=[];const r={devices:async()=>{if(fail)throw new Error('offline');return devices;},diagnostic:()=>({name:'Error',code:'CONNECTION',message:'offline'})};const m=new Monitor(config,r,s,{alert:async(key)=>sent.push(key)});
 await m.poll();s.updateDevice(1,{alias:'PC',category:'',critical:true});fail=true;const original=console.error;console.error=()=>{};try{await m.poll();await m.poll();await m.poll();}finally{console.error=original;}assert.equal(s.devices().filter(d=>d.online).length,2);assert.equal(sent.filter(k=>k==='router_down').length,1);fail=false;devices=[];await m.poll();assert.ok(sent.includes('router_up'));assert.ok(sent.includes('offline:1'));s.close();
});
test('poll no superpone consultas',async()=>{const s=new Store(':memory:');let release;let calls=0;const m=new Monitor(config,{devices:()=>{calls++;return new Promise(r=>release=r);}},s,{});const first=m.poll();await m.poll();assert.equal(calls,1);release([]);await first;s.close();});
test('diagnóstico redacta secretos incluso cause',()=>{const c=client([]);c.cookies.set('PHPSESSID','session-value');const result=JSON.stringify(c.diagnostic(new Error(`bad ${config.password} session-value`,{cause:new Error(config.token)})));assert.ok(!result.includes(config.password));assert.ok(!result.includes('session-value'));assert.ok(!result.includes(config.token));c.close();});
