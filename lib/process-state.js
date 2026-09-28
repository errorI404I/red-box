import { readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, existsSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
export function identity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z') return null;
    return {pid, start:fields[19], args:readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)};
  } catch { return null; }
}
export function atomicJSON(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), {mode:0o600}); renameSync(tmp, path);
}
export function lock(path) {
  const mine = identity(process.pid);
  for (let attempt=0; attempt<2; attempt++) {
    try { const fd=openSync(path,'wx',0o600); writeFileSync(fd,JSON.stringify(mine)); closeSync(fd); return () => {
      try { const owner=JSON.parse(readFileSync(path,'utf8')); if(owner.pid===mine.pid&&owner.start===mine.start)unlinkSync(path); } catch {}
    }; } catch(e) {
      if(e.code!=='EEXIST')throw e;
      let owner; try {owner=JSON.parse(readFileSync(path,'utf8'));} catch {throw new Error('Operación en curso; lock incompleto');}
      if(identity(owner.pid)?.start===owner.start)throw new Error('Operación en curso');
      unlinkSync(path);
    }
  }
  throw new Error('No se pudo adquirir el lock');
}
export function managedProcess(root, name) {
  const base=join(root,'data',name);
  if(!existsSync(`${base}.pid`))return null;
  const raw=readFileSync(`${base}.pid`,'utf8').trim();
  if(!/^[1-9]\d*$/.test(raw))throw new Error('PID inválido; no se tocaron procesos');
  const current=identity(Number(raw));
  if(!current)return null;
  let saved; try {saved=JSON.parse(readFileSync(`${base}-state.json`,'utf8'));} catch {
    // Migrate only a verifiable legacy Red Box PID created by the original start.sh.
    if(name==='red-box'&&current.args[1]===join(root,'server.js')&&readlinkSync(`/proc/${current.pid}/cwd`)===root){saveProcess(root,name,current.pid);return current;}
    throw new Error('No se puede verificar la identidad del PID');
  }
  if(saved.pid!==current.pid||saved.start!==current.start||saved.root!==root||JSON.stringify(saved.args)!==JSON.stringify(current.args))throw new Error('PID pertenece a otro proceso; no se tocaron procesos');
  return current;
}
export function saveProcess(root, name, pid) {
  const current=identity(pid);if(!current)throw new Error('El proceso no inició');
  atomicJSON(join(root,'data',`${name}-state.json`),{...current,root});
  writeFileSync(join(root,'data',`${name}.pid`),String(pid),{mode:0o600});
}
export function cleanProcess(root,name) {
  for(const suffix of ['.pid','-state.json'])try{unlinkSync(join(root,'data',name+suffix));}catch(e){if(e.code!=='ENOENT')throw e;}
}
export function safeEnvironment() {
  return Object.fromEntries(['PATH','HOME','PREFIX','TMPDIR','LANG','LD_LIBRARY_PATH','ANDROID_ROOT','ANDROID_DATA','SYSTEMROOT'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
}
