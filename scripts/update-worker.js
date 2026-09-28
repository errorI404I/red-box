import { fileURLToPath } from 'node:url';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { updateProject, recoverUpdate } from '../lib/update.js';
const root=fileURLToPath(new URL('../',import.meta.url)).replace(/\/$/,'');
mkdirSync(`${root}/data`,{recursive:true,mode:0o700});
try{
  if(process.argv[2]==='--recover'||existsSync(`${root}/data/update-journal.json`))await recoverUpdate(root);
  else if(process.argv.length===2)await updateProject(root);
  else throw new Error('Argumento inválido');
}
catch{appendFileSync(`${root}/data/update.log`,`${new Date().toISOString()} Actualización/recuperación detenida. Revisar proceso activo, repositorio y archivos data/update-*.\n`);process.exitCode=1;}
