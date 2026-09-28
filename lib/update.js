import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, appendFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJSON, lock, managedProcess, safeEnvironment } from './process-state.js';
export const updateStages = ['preparación','descarga','validación','dependencias','tests','instalación','reinicio','recuperación'];
const safeReasons=new Set(['No se pudo ejecutar la etapa','Etapa fallida','Tiempo de espera agotado en la etapa','Archivos privados no protegidos','Hay una actualización interrumpida pendiente de recuperación','Red Box debe iniciarse con start.sh','Cambios locales pendientes','Archivos privados versionados','Commit anterior inválido','La rama seleccionada no existe en origin','El destino versiona archivos privados','El proyecto cambió durante la actualización','Proceso reiniciado no disponible','Red Box no respondió después de reiniciar']);
export function resultMessage(result) {
  if(result?.state==='success' && /^[a-f0-9]{7,40}$/.test(result.commit || ''))return `${result.unchanged===true?'Red Box ya está actualizado.':'Red Box actualizado correctamente.'}\nCommit: ${result.commit.slice(0,7)}`;
  const stage=updateStages.includes(result?.stage)?result.stage:'preparación';
  const reason=safeReasons.has(result?.reason)?`${result.reason}. `:'';
  return `La actualización de Red Box falló (${stage}). ${reason}${result?.restored?'Se conservó o restauró la versión anterior.':'Revisar data/update.log en la TV Box.'}`;
}
export function runCommand(command,args,{cwd,timeout=120000,input,env=safeEnvironment()}={}) {
  return new Promise((resolve,reject)=>{
    let output='', done=false;
    const child=spawn(command,args,{cwd,env,detached:true,stdio:['pipe','pipe','pipe']});
    const finish=(error)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(output);};
    // Raw subprocess diagnostics are intentionally never logged or sent to Telegram.
    child.stdout.on('data',chunk=>{if(output.length<2e6)output+=chunk.toString();});
    child.stderr.resume(); child.stdin.on('error',()=>{});
    child.on('error',()=>finish(new Error('No se pudo ejecutar la etapa')));
    child.on('close',code=>finish(code===0?null:new Error('Etapa fallida')));
    const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}finish(new Error('Tiempo de espera agotado en la etapa'));},timeout);
    child.stdin.end(input);
  });
}
export async function updateProject(root,{run=runCommand,health=waitForApp,verifyProcess=()=>managedProcess(root,'red-box')}={}) {
  const data=join(root,'data');mkdirSync(data,{recursive:true,mode:0o700});
  const release=lock(join(data,'update.lock'));
  const id=randomUUID(), work=join(data,`update-${id}`), candidate=join(work,'candidate');
  const journalPath=join(data,'update-journal.json');
  const log=stage=>appendFileSync(join(data,'update.log'),`${new Date().toISOString()} ${stage}\n`,{mode:0o600});
  let stage='preparación', previous, target, changed=false, stopped=false, movedModules=false, installedModules=false;
  const exec=(command,args,extra={})=>run(command,args,{cwd:root,...extra});
  const git=args=>exec('git',args);
  // Branch names come exclusively from this checkout, never from Telegram or argv.
  const currentBranch=async()=>{
    try {
      const branch=(await git(['branch','--show-current'])).trim();
      if(!branch || branch.startsWith('-'))return 'master';
      await git(['check-ref-format',`refs/heads/${branch}`]);
      return branch;
    }catch{return 'master';}
  };
  const outcome=value=>atomicJSON(join(data,'update-result.json'),{id,...value});
  const safePaths=paths=>!paths.split(/[\0\n]/).some(path=>/^(?:\.env|data)(?:\/|$)/.test(path));
  // Check ignore rules with explicit stdin; never rely only on a textual .gitignore match.
  const checkIgnored=async workTree=>{
    const value=await exec('git',[...(workTree?['--work-tree',workTree]:[]),'check-ignore','--no-index','--stdin'],{input:'.env\ndata/__red_box_probe__\n'});
    if(!value.split('\n').includes('.env')||!value.split('\n').includes('data/__red_box_probe__'))throw new Error('Archivos privados no protegidos');
  };
  try {
    if(existsSync(journalPath))throw new Error('Hay una actualización interrumpida pendiente de recuperación');
    outcome({state:'running'});
    log(stage); mkdirSync(candidate,{recursive:true,mode:0o700});
    if(!verifyProcess())throw new Error('Red Box debe iniciarse con start.sh');
    if((await git(['status','--porcelain'])).trim())throw new Error('Cambios locales pendientes');
    if(!safePaths(await git(['ls-files','-z'])))throw new Error('Archivos privados versionados');
    await checkIgnored();
    previous=(await git(['rev-parse','HEAD'])).trim();
    if(!/^[a-f0-9]{40}$/.test(previous))throw new Error('Commit anterior inválido');
    const branch=await currentBranch();
    stage='descarga';log(stage);await git(['fetch','origin']);
    // Check the remote itself: fetch without pruning can leave a deleted branch cached.
    let remote;
    try {
      remote=(await git(['ls-remote','--exit-code','--heads','origin',`refs/heads/${branch}`])).trim().split(/\s+/);
      target=(await git(['rev-parse','--verify',`refs/remotes/origin/${branch}^{commit}`])).trim();
    }catch{throw new Error('La rama seleccionada no existe en origin');}
    if(!/^[a-f0-9]{40}$/.test(target)||remote[0]!==target||remote[1]!==`refs/heads/${branch}`)throw new Error('La rama seleccionada no existe en origin');
    if(previous===target){outcome({state:'success',commit:target,unchanged:true});log('Sin cambios: HEAD coincide con la rama remota');return;}
    stage='validación';log(stage);
    if(!safePaths(await git(['ls-tree','-rz','--name-only',target])))throw new Error('El destino versiona archivos privados');
    await git(['archive','--format=tar',`--output=${join(work,'release.tar')}`,target]);
    await exec('tar',['-xf',join(work,'release.tar'),'-C',candidate]);
    await checkIgnored(candidate);
    stage='dependencias';log(stage);
    const install=existsSync(join(candidate,'package-lock.json'))?['ci']:['install','--package-lock=false'];
    await exec('npm',[...install,'--no-audit','--no-fund'],{cwd:candidate,timeout:600000});
    stage='tests';log(stage);await exec('npm',['test'],{cwd:candidate,timeout:600000});
    stage='instalación';log(stage);
    // Recheck after the long install/test phase; never discard user edits made meanwhile.
    if((await git(['status','--porcelain'])).trim() || (await git(['rev-parse','HEAD'])).trim()!==previous || await currentBranch()!==branch)throw new Error('El proyecto cambió durante la actualización');
    atomicJSON(journalPath,{id,previous,target,hadModules:existsSync(join(root,'node_modules'))});
    stopped=true;await exec('bash',[join(root,'stop.sh')]);
    changed=true;await git(['reset','--hard',target]);
    if(existsSync(join(root,'node_modules'))){renameSync(join(root,'node_modules'),join(work,'old-node_modules'));movedModules=true;}
    if(existsSync(join(candidate,'node_modules'))){renameSync(join(candidate,'node_modules'),join(root,'node_modules'));installedModules=true;}
    stage='reinicio';log(stage);await exec('bash',[join(root,'start.sh')]);
    await health();
    if(!verifyProcess())throw new Error('Proceso reiniciado no disponible');
    outcome({state:'success',commit:target});rmSync(journalPath,{force:true});log(`éxito commit=${target.slice(0,7)}`);
  }catch (error) {
    const reason=safeReasons.has(error.message)?error.message:'Etapa fallida';
    const failedStage=stage;let restored=!changed&&!stopped;
    if(stopped||changed){
      log('recuperación');
      try {
        await exec('bash',[join(root,'stop.sh')]);
        if(changed)await git(['reset','--hard',previous]);
        if(installedModules)rmSync(join(root,'node_modules'),{recursive:true,force:true});
        if(movedModules)renameSync(join(work,'old-node_modules'),join(root,'node_modules'));
        await exec('bash',[join(root,'start.sh')]);await health();restored=!!verifyProcess();
      }catch{restored=false;}
    }
    outcome({state:'failed',stage:failedStage,restored,reason});if(restored && stopped)rmSync(journalPath,{force:true});log(`fallo etapa=${failedStage} restaurado=${restored} motivo=${reason}`);
  }finally{release(); /* Keep staged files only if a failed rollback needs manual recovery. */
    let result;try{result=JSON.parse(readFileSync(join(data,'update-result.json'),'utf8'));}catch{}
    if(result?.state==='success'||result?.restored)rmSync(work,{recursive:true,force:true});
  }
}
export async function waitForApp() {
  for(let i=0;i<30;i++){
    try{const response=await fetch('http://127.0.0.1:8080/api/state',{signal:AbortSignal.timeout(1000)});if(response.ok && Array.isArray((await response.json()).devices))return;}catch{}
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  throw new Error('Red Box no respondió después de reiniciar');
}

// Called by Termux:Boot before starting the app after an interrupted installation.
export async function recoverUpdate(root,{run=runCommand,health=waitForApp,verifyProcess=()=>managedProcess(root,'red-box')}={}) {
  const data=join(root,'data'), journalPath=join(data,'update-journal.json');
  if(!existsSync(journalPath))return;
  const release=lock(join(data,'update.lock'));
  const exec=(command,args)=>run(command,args,{cwd:root});
  try {
    const journal=JSON.parse(readFileSync(journalPath,'utf8'));
    if(!/^[a-f0-9-]{36}$/.test(journal.id)||!(/^[a-f0-9]{40}$/).test(journal.previous)||!(/^[a-f0-9]{40}$/).test(journal.target))throw new Error('Journal inválido');
    const head=(await exec('git',['rev-parse','HEAD'])).trim();
    if(![journal.previous,journal.target].includes(head))throw new Error('El repositorio cambió después de la interrupción');
    let result;try{result=JSON.parse(readFileSync(join(data,'update-result.json'),'utf8'));}catch{}
    if(result?.id===journal.id&&result?.state==='success'&&head===journal.target){rmSync(journalPath);return;}
    if(verifyProcess())await exec('bash',[join(root,'stop.sh')]);
    await exec('git',['reset','--hard',journal.previous]);
    const work=join(data,`update-${journal.id}`),backup=join(work,'old-node_modules');
    if(existsSync(backup)){rmSync(join(root,'node_modules'),{recursive:true,force:true});renameSync(backup,join(root,'node_modules'));}
    else if(!journal.hadModules)rmSync(join(root,'node_modules'),{recursive:true,force:true});
    await exec('bash',[join(root,'start.sh')]);await health();
    if(!verifyProcess())throw new Error('La versión anterior no inició');
    atomicJSON(join(data,'update-result.json'),{id:journal.id,state:'failed',stage:'recuperación',restored:true});
    rmSync(journalPath);rmSync(work,{recursive:true,force:true});
    appendFileSync(join(data,'update.log'),`${new Date().toISOString()} Actualización interrumpida: versión anterior restaurada.\n`);
  }finally{release();}
}
