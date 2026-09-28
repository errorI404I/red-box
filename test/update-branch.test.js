import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { updateProject, resultMessage } from '../lib/update.js';

for (const scenario of [
  {name:'master',detected:'master',branch:'master'},
  {name:'otra rama válida',detected:'release/stable',branch:'release/stable'},
  {name:'rama ausente en origin aunque quede referencia local',detected:'master',branch:'master',missing:true},
  {name:'fallo de detección usa master',detectionFailure:true,branch:'master'},
  {name:'detached HEAD usa master',detected:'',branch:'master'},
  {name:'nombre inválido usa master',detected:'bad..branch',invalid:true,branch:'master'},
  {name:'HEAD ya coincide; no instala ni reinicia',detected:'master',branch:'master',unchanged:true},
  {name:'cambio de rama durante tests impide aplicar',detected:'master',branch:'master',switchBranch:true}
]) {
  test(`updater: ${scenario.name}`,async t=>{
    const root=mkdtempSync(join(tmpdir(),'red-box-branch-'));
    t.after(()=>rmSync(root,{recursive:true,force:true}));
    const previous='a'.repeat(40),target=scenario.unchanged?previous:'b'.repeat(40),calls=[];
    let detections=0;
    const run=async(command,args)=>{
      calls.push([command,...args]);
      if(command!=='git')return '';
      switch(args[0]) {
        case 'status': return '';
        case 'ls-files': return 'server.js\0';
        case 'branch':
          if(scenario.detectionFailure)throw new Error('detection failed');
          return scenario.switchBranch&&detections++>0?'another-branch':scenario.detected;
        case 'check-ref-format': if(scenario.invalid)throw new Error('invalid branch');return '';
        case 'rev-parse': return args.includes('HEAD')?previous:target;
        case 'ls-remote':
          if(scenario.missing)throw new Error('no matching remote branch');
          return `${target}\trefs/heads/${scenario.branch}\n`;
        case 'ls-tree': return 'server.js\0';
      }
      if(args.includes('check-ignore'))return '.env\ndata/__red_box_probe__\n';
      return '';
    };
    await updateProject(root,{run,verifyProcess:()=>true,health:async()=>{}});
    const result=JSON.parse(readFileSync(join(root,'data/update-result.json'),'utf8'));
    assert.ok(calls.some(c=>JSON.stringify(c)===JSON.stringify(['git','fetch','origin'])));
    assert.ok(calls.some(c=>JSON.stringify(c)===JSON.stringify(['git','ls-remote','--exit-code','--heads','origin',`refs/heads/${scenario.branch}`])));
    if(!scenario.missing)assert.ok(calls.some(c=>c.includes(`refs/remotes/origin/${scenario.branch}^{commit}`)));
    if(scenario.missing||scenario.switchBranch){assert.equal(result.state,'failed');assert.ok(!calls.some(c=>c.includes('--hard')));}
    else assert.equal(result.state,'success');
    if(scenario.unchanged){
      assert.equal(result.unchanged,true);assert.match(resultMessage(result),/ya está actualizado/);
      assert.ok(!calls.some(c=>['npm','tar','bash'].includes(c[0])||c.includes('archive')||c.includes('--hard')));
      assert.ok(!existsSync(join(root,'data/update-journal.json')));
    }
  });
}
