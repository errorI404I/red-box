import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Sagemcom,encodePassword} from '../lib/router/sagemcom.js';
const devices=readFileSync(new URL('./fixtures/devices.html',import.meta.url),'utf8');
const login=readFileSync(new URL('./fixtures/login.html',import.meta.url),'utf8');
const response=(status,body='',headers={})=>({status,body,headers});
function client(t,responses){
 const calls=[],logs=[];
 const router=new Sagemcom({routerUrl:'https://192.168.0.1',username:'custadmin',password:'contraseña-secreta',timeoutSeconds:1},{log:line=>logs.push(line),request:async(path,options)=>{
  calls.push({path,...options});assert.ok(responses.length,'No debe solicitar más respuestas ni entrar en loop');return responses.shift();
 }});
 t.after(()=>router.close());return {router,calls,logs};
}
for(const csrf of [true,false])test(`login ${csrf?'antiguo con CSRF':'nuevo sin cookies iniciales'} y cookies posteriores al POST`,async t=>{
 const {router,calls,logs}=client(t,[response(200,'',csrf?{'set-cookie':['csrfp_token=private-csrf','PHPSESSID=old-session']}:{}),response(302,'',{location:'main.php','set-cookie':['PHPSESSID=new-session','extra_cookie=extra-value']}),response(200,devices),response(200,devices)]);
 assert.equal((await router.devices()).length,2);await router.devices();
 const form=new URLSearchParams(calls[1].body);
 assert.deepEqual([...form.keys()],csrf?['username','password','csrfp_token']:['username','password']);
 assert.equal(form.get('username'),'custadmin');assert.equal(form.get('password'),encodePassword('contraseña-secreta'));
 if(csrf)assert.equal(form.get('csrfp_token'),'private-csrf');
 for(const call of calls.slice(2)){assert.match(call.headers.Cookie,/PHPSESSID=new-session/);assert.match(call.headers.Cookie,/extra_cookie=extra-value/);assert.ok(!call.headers.Cookie.includes('old-session'));}
 assert.equal(calls.filter(c=>c.path==='/check.php').length,1);
 assert.ok(logs.includes(`Sagemcom login csrf=${csrf}`));assert.ok(logs.includes('Sagemcom cookies post-login: PHPSESSID=true'));
 for(const secret of ['contraseña-secreta',encodePassword('contraseña-secreta'),'private-csrf','old-session','new-session','extra-value'])assert.ok(!logs.join('\n').includes(secret));
});
test('CSRF sin PHPSESSID inicial también se envía; 302 sin cookies no bloquea lectura',async t=>{
 const {router,calls,logs}=client(t,[response(200,'',{'set-cookie':['csrfp_token=only-token']}),response(302,'',{location:'main.php'}),response(200,devices)]);
 assert.equal((await router.devices()).length,2);assert.equal(new URLSearchParams(calls[1].body).get('csrfp_token'),'only-token');assert.ok(logs.includes('Sagemcom cookies post-login: PHPSESSID=false'));
});
for(const page of [login,'<html>Sin marcadores</html>',devices.replace('onlineHostMAC','otherVariable')])test('HTTP 200 con sesión inválida reautentica una vez y se recupera',async t=>{
 const {router,calls}=client(t,[response(200),response(302,'',{location:'main.php','set-cookie':['PHPSESSID=expired']}),response(200,page),response(200),response(302,'',{location:'main.php','set-cookie':['PHPSESSID=recovered']}),response(200,devices)]);
 assert.equal((await router.devices()).length,2);assert.equal(calls.length,6);assert.equal(calls.filter(c=>c.path==='/check.php').length,2);assert.match(calls[5].headers.Cookie,/PHPSESSID=recovered/);
});
test('dos páginas inválidas terminan en SESSION_EXPIRED sin loop',async t=>{
 const {router,calls}=client(t,[response(200),response(302,'',{location:'main.php'}),response(200,login),response(200),response(302,'',{location:'main.php'}),response(200,'<html>Sin marcadores</html>')]);
 await assert.rejects(router.devices(),{code:'SESSION_EXPIRED'});assert.equal(calls.length,6);
});
test('POST fallido durante reautenticación no vuelve a intentar',async t=>{
 const {router,calls}=client(t,[response(200),response(302,'',{location:'main.php'}),response(200,login),response(200),response(200,login)]);
 await assert.rejects(router.devices(),{code:'LOGIN'});assert.equal(calls.length,5);
});
test('marcadores presentes con datos inconsistentes siguen siendo error de parser',async t=>{
 const {router,calls}=client(t,[response(200),response(302,'',{location:'main.php'}),response(200,devices.replace('= 2;','= 3;'))]);
 await assert.rejects(router.devices(),{code:'PARSER'});assert.equal(calls.length,3);
});
