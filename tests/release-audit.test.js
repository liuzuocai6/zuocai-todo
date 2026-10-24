import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppHarness } from './helpers/app-harness.js';

const exercise = (name='卧推', sets=3, rest=90) => ({ name, recommended_sets:sets, recommended_reps_min:8, recommended_reps_max:12, recommended_weight:50, recommended_rir:2, rest_seconds:rest });
const task = (changes={}) => ({ title:'报告', importance:'medium', estimated_minutes:30, tags:[], plans:[], ...changes });
async function training({db,storage}) {
  const plan = await db.saveFitnessPlan({name:'推日',exercises:[exercise()]});
  storage.set('zuocai.activeWorkoutSession',await db.startWorkout(plan));
}

test('natural rest expiry unlocks the next set without hiding the rest card', async () => {
  const app = await createAppHarness({beforeStart:training});
  await app.submit({reps:10,weight:50,rir:2});
  assert.equal(app.document.querySelector('#set-form [name="reps"]').disabled,true);
  app.advance(91);
  await app.tick();
  assert.match(app.document.querySelector('#rest-countdown').textContent,/休息已完成/);
  assert.equal(app.document.querySelector('#set-form [name="reps"]').disabled,false);
});

test('saving a group beyond the snapshot recommendation is rejected at the database', async () => {
  const app = await createAppHarness({beforeStart:training});
  const state = await app.db.listState();
  await assert.rejects(app.db.saveWorkoutSet({workout_exercise_id:state.workoutExercises[0].id,set_number:4,actual_reps:10,actual_weight:50,actual_rir:2}),/组/);
  assert.equal((await app.db.listState()).workoutSets.length,0);
});

test('warmup editing and delete-then-add keep unique ordering and export remains importable', async () => {
  const app = await createAppHarness();
  const a = await app.db.saveWarmup({name:'开合跳',type:'reps',target_value:10,sort_order:0});
  const b = await app.db.saveWarmup({name:'肩绕环',type:'reps',target_value:10,sort_order:1});
  await app.db.saveWarmup({id:a,name:'开合跳修改',type:'reps',target_value:20,sort_order:2});
  assert.equal((await app.db.listState()).warmups[0].id,a);
  await app.db.deleteWarmup(a);
  await app.db.saveWarmup({name:'抬腿',type:'seconds',target_value:30,sort_order:1});
  const backup = await app.db.exportData();
  assert.doesNotThrow(()=>app.db.validateBackup(backup));
  await app.db.importData(backup);
  assert.equal((await app.db.listState()).warmups[0].id,b);
});

test('editing a far-future task retains its existing schedule', async () => {
  const app = await createAppHarness();
  const id = await app.db.saveTask(task({deadline:'2026-10-02',plans:[{plan_date:'2026-10-12',start_time:'14:00'}]}));
  // Refresh through the actual periodic App callback and then edit the visible card.
  await app.tick();
  const state = await app.db.listState();
  await app.click('[data-action="edit"]');
  const choices = [...app.document.querySelectorAll('#task-plan-dates .selected')];
  assert.equal(choices.length,1);
  assert.equal(choices[0].dataset.date,state.plans[0].plan_date);
  assert.equal(app.document.querySelector('.date-start-time[data-date="2026-10-12"]').value,'14:00');
});

test('foreground resume refreshes today and capacity even without a training page', async () => {
  const app = await createAppHarness({at:'2026-10-01T23:55:00+08:00',beforeStart:async ({db})=>{
    await db.saveTask(task({plans:[{plan_date:'2026-10-02',start_time:'10:00'}]}));
  }});
  assert.equal(app.document.querySelector('#today-count').textContent,'0');
  await app.emit('pause');
  app.advance(600);
  await app.emit('resume');
  assert.equal(app.document.querySelector('#today-count').textContent,'1');
  assert.match(app.document.querySelector('#pressure-capacity').textContent,/680/);
});

test('independent concurrent writes cannot open nested SQLite transactions', async () => {
  const app = await createAppHarness();
  const result = await Promise.allSettled([app.db.saveTask(task()),app.db.saveFitnessPlan({name:'推日',exercises:[exercise()]}),app.db.replaceNotifications([])]);
  assert.ok(result.every(item=>item.status==='fulfilled'),JSON.stringify(result.map(item=>String(item.reason))));
  const state = await app.db.listState();
  assert.equal(state.tasks.length,1);
  assert.equal(state.fitnessPlans.length,1);
});

test('whole backup round trip twice includes todos, routine, thoughts, warmups, plan and training history', async () => {
  const app = await createAppHarness({beforeStart:training});
  await app.db.saveTask(task({deadline:'2026-10-02',plans:[{plan_date:'2026-10-01',start_time:'17:00'}]}));
  await app.db.saveThought('今天训练');
  await app.db.saveWarmup({name:'热身',type:'reps',target_value:20});
  await app.submit({reps:10,weight:50,rir:2});
  const backup = app.db.validateBackup(await app.db.exportData());
  for(let i=0;i<2;i++) {
    await app.db.importData(backup);
    const restored = await app.db.exportData();
    for(const key of ['tasks','plans','thoughts','routine','fitnessPlans','fitnessExercises','warmups','workoutSessions','workoutExercises','workoutSets']) assert.deepEqual(JSON.parse(JSON.stringify(restored[key])),JSON.parse(JSON.stringify(backup[key])),key);
  }
  assert.equal(app.database.prepare('PRAGMA foreign_key_check').all().length,0);
});

test('an import SQL failure rolls back all deletions and the queue continues working', async () => {
  let fail=false;
  const app = await createAppHarness({intercept:async(kind,sql)=>{
    if(fail&&kind==='run'&&sql.startsWith('INSERT INTO thoughts')) throw new Error('模拟存储写入失败');
  }});
  await app.db.saveTask(task());
  await app.db.saveThought('保留的想法');
  const original = await app.db.exportData();
  const replacement = JSON.parse(JSON.stringify(original));
  replacement.tasks[0].title='替换任务';
  fail=true;
  await assert.rejects(app.db.importData(replacement),/模拟存储写入失败/);
  fail=false;
  const restored=await app.db.exportData();
  assert.deepEqual(JSON.parse(JSON.stringify(restored.tasks)),JSON.parse(JSON.stringify(original.tasks)));
  assert.deepEqual(JSON.parse(JSON.stringify(restored.thoughts)),JSON.parse(JSON.stringify(original.thoughts)));
  await app.db.saveThought('后续可保存');
  assert.equal((await app.db.listState()).thoughts.length,2);
});

test('saving the final group and session completion are one atomic operation', async () => {
  let fail=false;
  const app=await createAppHarness({beforeStart:async({db,storage})=>{
    storage.set('zuocai.activeWorkoutSession',await db.startWorkout(await db.saveFitnessPlan({name:'单组',exercises:[exercise('卧推',1)]})));
  },intercept:async(kind,sql)=>{
    if(fail&&kind==='run'&&sql.includes("SET status='completed'"))throw new Error('模拟中断');
  }});
  const ex=(await app.db.listState()).workoutExercises[0];
  const group={workout_exercise_id:ex.id,set_number:1,actual_reps:10,actual_weight:50,actual_rir:2};
  fail=true;
  await assert.rejects(app.db.saveWorkoutSetAndAdvance(group),/模拟中断/);
  const failed=await app.db.listState();
  assert.equal(failed.workoutSets.length,0);
  assert.equal(failed.workoutSessions[0].status,'in_progress');
  fail=false;
  await app.db.saveWorkoutSetAndAdvance(group);
  const success=await app.db.listState();
  assert.equal(success.workoutSets.length,1);
  assert.equal(success.workoutSessions[0].status,'completed');
  assert.ok(success.workoutSessions[0].ended_at);
});

test('renaming and permanently deleting an archived plan retains workout snapshots and groups', async () => {
  const app=await createAppHarness({beforeStart:training});
  const initial=await app.db.listState();
  await app.submit({reps:10,weight:50,rir:2});
  await app.db.finishWorkout(initial.workoutSessions[0].id,'incomplete');
  await app.db.saveFitnessPlan({id:initial.fitnessPlans[0].id,name:'新名称',exercises:[exercise('新动作')]});
  await app.db.archiveFitnessPlan(initial.fitnessPlans[0].id);
  await assert.rejects(app.db.startWorkout(initial.fitnessPlans[0].id),/归档/);
  await app.db.deleteFitnessPlan(initial.fitnessPlans[0].id);
  const retained=await app.db.listState();
  assert.equal(retained.workoutSessions[0].plan_id,null);
  assert.equal(retained.workoutSessions[0].plan_name,'推日');
  assert.equal(retained.workoutExercises[0].name,'卧推');
  assert.equal(retained.workoutSets.length,1);
  const exported=await app.db.exportData();
  assert.doesNotThrow(()=>app.db.validateBackup(exported));
});

test('normal task edits retain schedule ID and long term deselection retains completed other days', async () => {
  const app=await createAppHarness();
  const id=await app.db.saveTask(task({plans:[{plan_date:'2026-10-01',start_time:'10:00'}]}));
  let state=await app.db.listState();
  const pid=state.plans[0].id;
  await app.db.saveTask({...state.tasks[0],title:'修改标题',plans:state.plans});
  state=await app.db.listState();
  assert.equal(state.plans[0].id,pid);
  await app.db.deleteTask(id);
  assert.equal((await app.db.listState()).plans.length,0);
  await app.db.saveTask(task({is_long_term:true,plans:[{plan_date:'2026-09-30',completed_at:'2026-09-30T12:00:00Z'},{plan_date:'2026-10-01'},{plan_date:'2026-10-02'}]}));
  state=await app.db.listState();
  await app.db.saveTask({...state.tasks[0],plans:state.plans.filter(p=>p.plan_date!=='2026-10-01')});
  state=await app.db.listState();
  assert.deepEqual([...state.plans].map(p=>p.plan_date),['2026-09-30','2026-10-02']);
  assert.ok(state.plans[0].completed_at);
});

test('pause, add 30 seconds, restart and resume retain paused rest and records', async () => {
  const app=await createAppHarness({beforeStart:training});
  await app.submit({reps:10,weight:50,rir:2});
  app.advance(20);
  await app.click('[data-fitness-action="pause-rest"]');
  assert.equal((await app.db.listState()).workoutSessions[0].rest_paused_seconds,70);
  await app.click('[data-fitness-action="add-rest"]');
  assert.equal((await app.db.listState()).workoutSessions[0].rest_paused_seconds,100);
  app.dispose();
  const restarted=await createAppHarness({database:app.database,storage:app.storage,at:'2026-10-01T08:05:00Z'});
  assert.match(restarted.document.querySelector('#rest-countdown').textContent,/暂停/);
  assert.equal((await restarted.db.listState()).workoutSets.length,1);
  await restarted.click('[data-fitness-action="resume-rest"]');
  assert.match(restarted.document.querySelector('#rest-countdown').textContent,/1:40/);
  await restarted.click('[data-fitness-action="skip-rest"]');
  assert.equal(restarted.document.querySelector('#set-form [name="reps"]').disabled,false);
});

test('only unfinished exercises accept groups and existing next exercise progress is retained', async () => {
  const app=await createAppHarness({beforeStart:async({db,storage})=>{
    storage.set('zuocai.activeWorkoutSession',await db.startWorkout(await db.saveFitnessPlan({name:'双动作',exercises:[exercise('A',1,0),exercise('B',3,0)]})));
  }});
  await app.click('[data-fitness-action="select-exercise"][data-index="1"]');
  await app.submit({reps:8,weight:20,rir:2});
  await app.click('[data-fitness-action="select-exercise"][data-index="0"]');
  await app.submit({reps:10,weight:50,rir:2});
  assert.equal((await app.db.listState()).workoutSessions[0].current_set,2);
  await app.click('[data-fitness-action="select-exercise"][data-index="0"]');
  assert.equal(app.document.querySelector('#set-form [name="reps"]').disabled,true);
  assert.match(app.document.querySelector('#set-form button').textContent,/已完成/);
});

test('completed restored page shows no editable groups and database rejects all writes', async () => {
  const app=await createAppHarness({beforeStart:training});
  const initial=await app.db.listState();
  await app.db.finishWorkout(initial.workoutSessions[0].id);
  await app.emit('pause');
  await app.emit('resume');
  assert.equal(app.document.querySelector('#workout-dialog').open,false);
  assert.match(app.document.querySelector('#fitness-current').textContent,/已完成/);
  const group={workout_exercise_id:initial.workoutExercises[0].id,set_number:1,actual_reps:10,actual_weight:50};
  await assert.rejects(app.db.saveWorkoutSet(group),/已经结束/);
  await app.db.archiveWorkout(initial.workoutSessions[0].id);
  await assert.rejects(app.db.saveWorkoutSetAndAdvance(group),/已经结束/);
  assert.equal((await app.db.listState()).workoutSets.length,0);
});

test('date toggle retains entered times and ordinary selection stays exclusive', async () => {
  const app=await createAppHarness();
  await app.click('[data-action="new-task"]');
  await app.click('.date-choice[data-date="2026-10-01"]');
  app.document.querySelector('.date-start-time[data-date="2026-10-01"]').value='15:30';
  await app.click('.date-choice[data-date="2026-10-01"]');
  assert.equal(app.document.querySelectorAll('#task-plan-dates .selected').length,0);
  await app.click('.date-choice[data-date="2026-10-01"]');
  assert.equal(app.document.querySelector('.date-start-time[data-date="2026-10-01"]').value,'15:30');
  await app.click('.date-choice[data-date="2026-10-02"]');
  assert.equal(app.document.querySelectorAll('#task-plan-dates .selected').length,1);
});

test('editing settings survives both periodic refresh and foreground recovery', async () => {
  const app=await createAppHarness();
  const input=app.document.querySelector('#routine-form [name="wake_time"]');
  input.value='09:00';
  input.dispatchEvent(new app.window.Event('input',{bubbles:true}));
  await app.tick();
  await app.emit('pause');
  await app.emit('resume');
  assert.equal(input.value,'09:00');
  assert.equal((await app.db.listState()).routine.wake_time,'07:00');
});

test('exercise down button moves the row and saving uses that new order', async () => {
  const app=await createAppHarness({beforeStart:async({db})=>{
    await db.saveFitnessPlan({name:'排序',exercises:[exercise('A'),exercise('B')]});
  }});
  await app.click('[data-fitness-action="edit-plan"]');
  await app.click('#exercise-editor .exercise-down');
  assert.equal(app.document.querySelector('#exercise-editor [name="ename"]').value,'B');
});

test('double starting workouts creates only one session and snapshot', async () => {
  const app=await createAppHarness();
  const pid=await app.db.saveFitnessPlan({name:'推日',exercises:[exercise()]});
  const result=await Promise.allSettled([app.db.startWorkout(pid),app.db.startWorkout(pid)]);
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await app.db.listState()).workoutSessions.length,1);
});

test('invalid writes and inverted routine times are rejected without changing state', async () => {
  const app=await createAppHarness();
  await assert.rejects(app.db.saveTask(task({title:'  '})),/不能为空/);
  await assert.rejects(app.db.saveTask(task({estimated_minutes:NaN})),/分钟/);
  await assert.rejects(app.db.saveFitnessPlan({name:'错误',exercises:[exercise('A',0)]}),/组数/);
  const routine=(await app.db.listState()).routine;
  await assert.rejects(app.db.saveRoutine({...routine,lunch_start:'14:00',lunch_end:'13:00'}),/三餐/);
  assert.equal((await app.db.listState()).tasks.length,0);
  assert.equal((await app.db.listState()).routine.lunch_start,'12:00');
});

test('a queued old timer callback cannot cancel the newly rendered rest timer', async () => {
  const app=await createAppHarness({beforeStart:training});
  await app.submit({reps:10,weight:50,rir:2});
  const old=[...app.timers.values()].find(timer=>timer.ms===1000).callback;
  await app.click('[data-fitness-action="add-rest"]');
  old();
  app.advance(10);
  await app.tick();
  assert.match(app.document.querySelector('#rest-countdown').textContent,/1:50/);
});

test('closing workout while a set write is awaiting SQLite leaves the page closed', async () => {
  let hold=false,release,blocked=false;
  const app=await createAppHarness({beforeStart:training,intercept:async(kind,sql)=>{
    if(hold&&!blocked&&kind==='run'&&sql.startsWith('INSERT INTO workout_sets')){
      blocked=true;await new Promise(resolve=>{release=resolve});
    }
  }});
  hold=true;
  const saving=app.submit({reps:10,weight:50,rir:2});
  await app.flush();
  assert.equal(blocked,true);
  await app.emit('backButton');
  release();
  await saving;
  assert.equal(app.document.querySelector('#workout-dialog').open,false);
  assert.equal((await app.db.listState()).workoutSets.length,1);
});

test('ending requires confirmation, while cancelling and closing retain active training', async () => {
  let accepted=false,asked=0;
  const app=await createAppHarness({beforeStart:training,confirmation:()=>{asked++;return accepted}});
  await app.submit({reps:10,weight:50,rir:2});
  await app.click('[data-fitness-action="finish-incomplete"]');
  assert.equal(asked,1);
  assert.equal(app.document.querySelector('#workout-dialog').open,true);
  assert.equal((await app.db.listState()).workoutSessions[0].status,'in_progress');
  accepted=true;
  await app.click('[data-fitness-action="finish-incomplete"]');
  const ended=await app.db.listState();
  assert.equal(ended.workoutSessions[0].status,'incomplete');
  assert.equal(ended.workoutSets.length,1);
  assert.equal(app.document.querySelector('#workout-dialog').open,false);
});

test('Android back closes ordinary dialogs and minimizes only on the main page', async () => {
  const app=await createAppHarness();
  await app.click('[data-action="new-task"]');
  await app.emit('backButton');
  assert.equal(app.document.querySelector('#task-dialog').open,false);
  assert.equal(app.minimized.count,0);
  await app.emit('backButton');
  assert.equal(app.minimized.count,1);
});

test('old duplicate warmup ordering is repaired at startup without losing any warmups', async () => {
  const app=await createAppHarness();
  const a=await app.db.saveWarmup({name:'A',type:'reps',target_value:10});
  await app.db.saveWarmup({name:'B',type:'reps',target_value:10});
  app.database.prepare('UPDATE warmups SET sort_order=1 WHERE id=?').run(a);
  app.dispose();
  const restarted=await createAppHarness({database:app.database,storage:app.storage});
  const warmups=(await restarted.db.listState()).warmups;
  assert.equal(warmups.length,2);
  assert.deepEqual([...warmups].map(w=>w.sort_order),[0,1]);
  const backup=await restarted.db.exportData();
  assert.doesNotThrow(()=>restarted.db.validateBackup(backup));
});

test('legacy schema 1 and 2 backups import without fitness fields',async()=>{
  const app=await createAppHarness();
  await app.db.saveTask(task());
  const exported=JSON.parse(JSON.stringify(await app.db.exportData()));
  for(const version of [1,2]){
    const old={schema_version:version,tasks:exported.tasks,plans:exported.plans,thoughts:exported.thoughts,routine:exported.routine};
    delete old.routine.rest_minutes_per_hour;
    await app.db.importData(old);
    const restored=await app.db.listState();
    assert.equal(restored.tasks.length,1);
    assert.equal(restored.workoutSessions.length,0);
    assert.equal(restored.routine.rest_minutes_per_hour,'10');
  }
});

test('empty, todo-only and fitness-only backups can be immediately imported twice',async()=>{
  const app=await createAppHarness();
  for(const kind of ['empty','todo','fitness']){
    if(kind==='todo')await app.db.saveTask(task());
    if(kind==='fitness'){
      const s=await app.db.listState();await app.db.deleteTask(s.tasks[0].id);
      await app.db.saveFitnessPlan({name:'健身计划',exercises:[exercise()]});
    }
    const backup=await app.db.exportData();
    await app.db.importData(backup);await app.db.importData(backup);
    const restored=await app.db.listState();
    assert.equal(restored.tasks.length,kind==='todo'?1:0);
    assert.equal(restored.fitnessPlans.length,kind==='fitness'?1:0);
  }
});

test('same-day repeated plan creates separate ended sessions and archives/restores independently',async()=>{
  const app=await createAppHarness();
  const plan=await app.db.saveFitnessPlan({name:'推日',exercises:[exercise('A',1)]});
  const first=await app.db.startWorkout(plan);await app.db.finishWorkout(first,'incomplete');
  const second=await app.db.startWorkout(plan);await app.db.finishWorkout(second,'incomplete');
  assert.notEqual(first,second);
  await app.db.archiveWorkout(first);
  let state=await app.db.listState();
  assert.equal(state.workoutSessions.filter(s=>s.archived).length,1);
  await app.db.restoreWorkout(first);
  state=await app.db.listState();
  assert.equal(state.workoutSessions.length,2);
  assert.equal(state.workoutSessions.filter(s=>s.archived).length,0);
});

test('invalid form submit shows an error and retains user inputs for correction',async()=>{
  const app=await createAppHarness();
  await app.click('[data-fitness-action="new-plan"]');
  app.document.querySelector('#fitness-plan-form [name="name"]').value=' ';
  app.document.querySelector('#fitness-plan-form').dispatchEvent(new app.window.Event('submit',{bubbles:true,cancelable:true}));
  await app.flush();
  assert.equal((await app.db.listState()).fitnessPlans.length,0);
  assert.match(app.document.querySelector('#toast').textContent,/不能为空/);
  assert.equal(app.document.querySelector('#fitness-plan-dialog').open,true);
});

test('recorded training imported without localStorage never returns to warmup',async()=>{
  const app=await createAppHarness({beforeStart:training});
  await app.db.saveWarmup({name:'热身',type:'reps',target_value:10});
  await app.submit({reps:10,weight:50,rir:2});
  app.dispose();
  const restarted=await createAppHarness({database:app.database,storage:new Map()});
  assert.ok(restarted.document.querySelector('#set-form'));
  assert.ok(restarted.document.querySelector('#rest-countdown'));
  assert.equal(restarted.document.querySelector('[data-fitness-action="warmup-next"]'),null);
});

test('saving routine clears the edit guard so subsequent refresh shows persisted settings',async()=>{
  const app=await createAppHarness();
  const form=app.document.querySelector('#routine-form');
  form.elements.wake_time.value='06:30';
  form.dispatchEvent(new app.window.Event('input',{bubbles:true}));
  form.dispatchEvent(new app.window.Event('submit',{bubbles:true,cancelable:true}));
  await app.flush();
  assert.equal(form.hasAttribute('data-dirty'),false);
  assert.equal((await app.db.listState()).routine.wake_time,'06:30');
  await app.db.saveRoutine({...((await app.db.listState()).routine),wake_time:'06:00'});
  await app.tick();
  assert.equal(form.elements.wake_time.value,'06:00');
});

test('ending training clears its timer and rapid duplicate taps confirm only once',async()=>{
  let asked=0;
  const app=await createAppHarness({beforeStart:training,confirmation:()=>{asked++;return true}});
  await app.submit({reps:10,weight:50,rir:2});
  const button=app.document.querySelector('[data-fitness-action="finish-incomplete"]');
  button.click();button.click();
  await app.flush();
  assert.equal(asked,1);
  assert.equal((await app.db.listState()).workoutSessions[0].status,'incomplete');
  assert.equal([...app.timers.values()].filter(timer=>timer.ms===1000).length,0);
});

test('an in-flight set save cannot race a finish tap and still completes normally',async()=>{
  let hold=false,release,blocked=false,asked=0;
  const app=await createAppHarness({beforeStart:training,confirmation:()=>{asked++;return true},intercept:async(kind,sql)=>{
    if(hold&&!blocked&&kind==='run'&&sql.startsWith('INSERT INTO workout_sets')){
      blocked=true;await new Promise(resolve=>{release=resolve});
    }
  }});
  hold=true;
  const saving=app.submit({reps:10,weight:50,rir:2});
  await app.flush();
  assert.equal(blocked,true);
  await app.click('[data-fitness-action="finish-incomplete"]');
  assert.equal(asked,0);
  assert.match(app.document.querySelector('#toast').textContent,/正在保存/);
  release();await saving;
  assert.equal((await app.db.listState()).workoutSessions[0].status,'in_progress');
  await app.click('[data-fitness-action="finish-incomplete"]');
  assert.equal(asked,1);
  assert.equal((await app.db.listState()).workoutSets.length,1);
});

test('invalid rest and progress patches are rejected and the queue remains usable',async()=>{
  const app=await createAppHarness({beforeStart:training});
  const initial=await app.db.listState(),id=initial.workoutSessions[0].id;
  for(const patch of [
    {rest_paused_seconds:-1},{rest_paused_seconds:3601},
    {rest_end_at:'not a time'},
    {rest_end_at:'2026-10-01T08:01:30Z',rest_paused_seconds:30},
    {current_exercise:1},{current_set:4},{status:'completed'},
  ]) await assert.rejects(app.db.updateWorkoutSession(id,patch));
  await app.db.updateWorkoutSession(id,{rest_end_at:'2026-10-01T08:01:30Z',rest_paused_seconds:null});
  const saved=await app.db.listState();
  assert.equal(saved.workoutSessions[0].status,'in_progress');
  assert.equal(saved.workoutSessions[0].rest_end_at,'2026-10-01T08:01:30Z');
});

test('invalid next-group progress rolls back the group insert together',async()=>{
  const app=await createAppHarness({beforeStart:training});
  const initial=await app.db.listState();
  await assert.rejects(app.db.saveWorkoutSetAndAdvance({workout_exercise_id:initial.workoutExercises[0].id,set_number:1,actual_reps:10,actual_weight:50},{current_set:4}),/组序号/);
  assert.equal((await app.db.listState()).workoutSets.length,0);
});

test('old interrupted completion is recovered at startup and on import without changing recorded groups',async()=>{
  const app=await createAppHarness();
  const id=await app.db.startWorkout(await app.db.saveFitnessPlan({name:'旧版完成恢复',exercises:[exercise('A',1)]}));
  const ex=(await app.db.listState()).workoutExercises[0];
  // Reproduce the old separate final-set save and session finish operations.
  await app.db.saveWorkoutSet({workout_exercise_id:ex.id,set_number:1,actual_reps:10,actual_weight:50});
  const backup=await app.db.exportData();
  assert.equal(backup.workoutSessions[0].status,'in_progress');
  app.dispose();
  const restarted=await createAppHarness({database:app.database,storage:app.storage,at:'2026-10-01T08:05:00Z'});
  let state=await restarted.db.listState();
  assert.equal(state.workoutSessions[0].status,'completed');
  assert.equal(state.workoutSessions[0].ended_at,state.workoutSets[0].completed_at);
  assert.equal(state.workoutSets.length,1);
  assert.equal(restarted.document.querySelector('#workout-dialog').open,false);
  await restarted.db.importData(backup);
  state=await restarted.db.listState();
  assert.equal(state.workoutSessions.find(s=>s.id===id).status,'completed');
  assert.equal(state.workoutSets[0].actual_reps,10);
});

test('ordinary edited schedule saving through the form retains far-future date and selected cancellation removes it',async()=>{
  const app=await createAppHarness();
  await app.db.saveTask(task({plans:[{plan_date:'2026-10-12',start_time:'14:00'}]}));
  await app.tick();await app.click('[data-action="edit"]');
  const form=app.document.querySelector('#task-form');
  form.elements.title.value='修改标题';
  form.dispatchEvent(new app.window.Event('submit',{bubbles:true,cancelable:true}));await app.flush();
  assert.equal((await app.db.listState()).plans[0].plan_date,'2026-10-12');
  await app.click('[data-action="edit"]');
  await app.click('.date-choice[data-date="2026-10-12"]');
  form.dispatchEvent(new app.window.Event('submit',{bubbles:true,cancelable:true}));await app.flush();
  assert.equal((await app.db.listState()).plans.length,0);
});
