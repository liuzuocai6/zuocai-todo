import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

async function nativeHarness({shareFailure=false,writeFailure=false,androidDates=false}={}) {
  const pending=new Map(),calls={cancel:[],schedule:[],write:[],share:[]};
  const androidDate = value => {
    const d=new Date(Date.parse(value)+8*3600000);
    return `${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()]} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2,'0')} ${d.toISOString().slice(11,19)} GMT+08:00 ${d.getUTCFullYear()}`;
  };
  const LocalNotifications={
    checkPermissions:async()=>({display:'granted'}),
    getPending:async()=>({notifications:[...pending.values()].map(n=>androidDates?{...n,schedule:{...n.schedule,at:androidDate(n.schedule.at)}}:n)}),
    cancel:async({notifications})=>{calls.cancel.push(notifications);for(const item of notifications)pending.delete(item.id)},
    schedule:async({notifications})=>{calls.schedule.push(notifications);for(const item of notifications)pending.set(item.id,item)}
  };
  const Filesystem={writeFile:async options=>{if(writeFailure)throw new Error('磁盘写入失败');calls.write.push(options);return {uri:`file:///test-cache/${options.path}`}}};
  const Share={share:async options=>{calls.share.push(options);if(shareFailure)throw new Error('已关闭分享面板')}};
  const context=vm.createContext({Date,console});
  const source=new vm.SourceTextModule(readFileSync(new URL('../src/native.js',import.meta.url),'utf8'),{context});
  await source.link(async name=>{
    if(name==='./notification-model.js')return new vm.SourceTextModule(readFileSync(new URL('../src/notification-model.js',import.meta.url),'utf8'),{context});
    const exports=name==='@capacitor/local-notifications'?{LocalNotifications}:name==='@capacitor/filesystem'?{Filesystem,Directory:{Cache:'CACHE'},Encoding:{UTF8:'utf8'}}:{Share};
    return new vm.SyntheticModule(Object.keys(exports),function(){for(const[key,value]of Object.entries(exports))this.setExport(key,value)},{context});
  });
  await source.evaluate();
  return {native:source.namespace,pending,calls};
}

test('notification verification preserves unchanged future alarms and replaces only modified alarms',async()=>{
  const {native,pending,calls}=await nativeHarness();
  const tasks=[{id:'t',title:'报告',deadline:'2099-10-01'}];
  await native.rescheduleNotifications(tasks,[]);
  assert.equal(pending.size,1);
  const first=calls.schedule.length;
  await native.rescheduleNotifications(tasks,[]);
  assert.equal(calls.schedule.length,first);
  assert.equal(calls.cancel.length,0);
  tasks[0].title='修改报告';
  const result=await native.rescheduleNotifications(tasks,[]);
  assert.equal(result.records.length,1);
  assert.equal(calls.cancel.length,1);
  assert.equal(calls.schedule.length,first+1);
  assert.equal([...pending.values()][0].body,'修改报告');
});

test('completed task clears only its pending ordinary alarm and retains the test alarm',async()=>{
  const {native,pending}=await nativeHarness();
  const tasks=[{id:'t',title:'报告',deadline:'2099-10-01'}];
  await native.rescheduleNotifications(tasks,[]);
  await native.scheduleTestNotification();
  assert.equal(pending.size,2);
  tasks[0].completed_at='done';
  await native.rescheduleNotifications(tasks,[]);
  assert.equal(pending.size,1);
  assert.ok(pending.has(native.TEST_NOTIFICATION_ID));
});

test('Android pending Java date strings verify without cancelling unchanged reminders',async()=>{
  const {native,calls}=await nativeHarness({androidDates:true});
  const tasks=[{id:'t',title:'报告',deadline:'2099-10-01'}];
  const first=await native.rescheduleNotifications(tasks,[]);
  assert.equal(first.records.length,1);
  assert.equal((await native.rescheduleNotifications(tasks,[])).records.length,1);
  assert.equal(calls.schedule.length,1);
  assert.equal(calls.cancel.length,0);
});

test('CSV writes a BOM file and cancellation of Android share handoff is not a write failure',async()=>{
  const {native,calls}=await nativeHarness({shareFailure:true});
  const file=await native.exportWorkoutStatsCsv('动作,次数\r\n卧推,10');
  assert.match(file,/\.csv$/);
  assert.ok(calls.write[0].data.startsWith('\uFEFF动作'));
  assert.ok(calls.share[0].files[0].endsWith('.csv'));
  assert.equal(calls.share[0].text,undefined);
});

test('actual export write failures remain visible and never open a share handoff',async()=>{
  const {native,calls}=await nativeHarness({writeFailure:true});
  await assert.rejects(native.exportWorkoutStatsCsv('数据'),/磁盘/);
  assert.equal(calls.share.length,0);
});
