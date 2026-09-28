const $=s=>document.querySelector(s);
const node=(tag,text,cls)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el;};
const date=value=>value?new Date(value).toLocaleString():'—';
async function api(path,method='GET',data) { const res=await fetch(path,{method,...(method==='GET'?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(data||{})})});const result=await res.json();if(!res.ok)throw new Error(result.error);return result; }
for(const button of document.querySelectorAll('[data-tab]')) button.onclick=()=>{for(const section of document.querySelectorAll('main>section'))section.hidden=section.id!==button.dataset.tab;for(const b of document.querySelectorAll('[data-tab]'))b.setAttribute('aria-pressed',String(b===button));};
$('[data-tab="home"]').click();
function events(target,items) { target.replaceChildren();if(!items.length)target.append(node('p','Sin eventos todavía.'));for(const e of items){const row=node('article');row.append(node('small',date(e.timestamp)),node('p',e.message));target.append(row);} }
let editing=false;
function renderDevices(devices) {
  const list=$('#device-list');list.replaceChildren();
  if(!devices.length)list.append(node('p','Todavía no hay dispositivos registrados.'));
  for(const d of devices) {
    const card=node('article');card.append(node('h3',d.alias||d.hostname||d.mac),node('p',d.online?'● Online':'○ Offline'));
    const details=node('dl');for(const [label,value] of [['IP',d.ip],['MAC',d.mac],['Conexión',d.connection],['RSSI',d.rssi===null?null:`${d.rssi} dBm`],['Asignación',d.assignment],['Última vez visto',date(d.last_seen)]])details.append(node('dt',label),node('dd',value??'—'));card.append(details);
    const form=node('form');const inputs={};for(const field of ['alias','category']){const label=node('label',field==='alias'?'Alias':'Categoría');const input=node('input');input.value=d[field]||'';input.maxLength=100;inputs[field]=input;label.append(input);form.append(label);}
    const critical=node('input');critical.type='checkbox';critical.checked=!!d.critical;const label=node('label','Crítico ');label.append(critical);form.append(label,node('button','Guardar'));form.oninput=()=>{editing=true;};form.onsubmit=async e=>{e.preventDefault();try{await api(`/api/devices/${d.id}`,'PATCH',{alias:inputs.alias.value,category:inputs.category.value,critical:critical.checked});editing=false;await refresh();}catch(e){$('#error').textContent=e.message;}};card.append(form);list.append(card);
  }
}
async function refresh() { try {
  const state=await api('/api/state');$('#error').textContent='';
  const online=state.devices.filter(d=>d.online).length;const critical=state.devices.filter(d=>!d.online&&d.critical).length;const recent=state.devices.filter(d=>Date.now()-Date.parse(d.first_seen)<86400000).length;
  const summary=$('#summary');summary.replaceChildren();
  for(const [title,lines] of [['Router',[state.router.status,`Última consulta: ${date(state.router.lastQuery)}`,`Último éxito: ${date(state.router.lastSuccess)}`,`Dispositivos: ${state.router.count??'—'}`,state.router.error?`${state.router.error.code}: ${state.router.error.message}`:'']],['Dispositivos',[`${online} online`,`${critical} críticos offline`,`${recent} nuevos en 24 horas`]],['Telegram',[state.telegram,state.telegram==='validado'?'Prueba exitosa':'No validado']]]){const card=node('article');card.append(node('h3',title));for(const line of lines)if(line)card.append(node('p',line));summary.append(card);}
  events($('#recent'),state.events.slice(0,8));events($('#event-list'),state.events);if(!editing)renderDevices(state.devices);$('#telegram-status').textContent=state.telegram;if(document.activeElement!==$('#cooldown'))$('#cooldown').value=state.cooldown;
 }catch(e){$('#error').textContent=`Servidor no disponible: ${e.message}`;} }
$('#test').onclick=async()=>{const button=$('#test');button.disabled=true;$('#test-result').textContent='Enviando…';try{await api('/api/telegram/test','POST');$('#test-result').textContent='Telegram validado.';await refresh();}catch(e){$('#test-result').textContent=e.message;}finally{button.disabled=false;}};
$('#settings-form').onsubmit=async e=>{e.preventDefault();try{await api('/api/settings','PATCH',{cooldown:Number($('#cooldown').value)});$('#test-result').textContent='Cooldown guardado.';}catch(e){$('#test-result').textContent=e.message;}};
async function tick(){await refresh();setTimeout(tick,10000);}void tick();
