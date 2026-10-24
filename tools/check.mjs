import {readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const src=fileURLToPath(new URL('../src/',import.meta.url));
for(const name of readdirSync(src).filter(name=>name.endsWith('.js'))){
  const result=spawnSync(process.execPath,['--check',`${src}/${name}`],{stdio:'inherit'});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status||1);
}
console.log('所有生产 JavaScript 文件语法检查通过。');
