import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppHarness } from './helpers/app-harness.js';

const exercise = (name='卧推',sets=3,rest=90) => ({name,recommended_sets:sets,recommended_reps_min:8,recommended_reps_max:12,recommended_weight:50,recommended_rir:2,rest_seconds:rest});
async function training({db,storage}) {
  const id=await db.startWorkout(await db.saveFitnessPlan({name:'推日',exercises:[exercise()]}));
  storage.set('zuocai.activeWorkoutSession',id);
}

test('background redraw preserves entered next-set values and saves them once',async()=>{
  const app=await createAppHarness({beforeStart:training});
  const form=app.document.querySelector('#set-form');
  form.elements.reps.value='9';form.elements.weight.value='52.5';form.elements.rir.value='1';
  await app.emit('pause');app.advance(30);await app.emit('resume');
  const restored=app.document.querySelector('#set-form');
  assert.equal(restored.elements.reps.value,'9');
  assert.equal(restored.elements.weight.value,'52.5');
  assert.equal(restored.elements.rir.value,'1');
  await app.submit({reps:9,weight:52.5,rir:1});
  const state=await app.db.listState();
  assert.equal(state.workoutSets.length,1);
  assert.equal(state.workoutSets[0].actual_reps,9);
  assert.equal(app.document.querySelector('#set-form').elements.reps.value,'');
});

test('closing and returning to training preserves a draft but ending clears it',async()=>{
  const app=await createAppHarness({beforeStart:training});
  app.document.querySelector('#set-form').elements.reps.value='11';
  await app.emit('backButton');
  await app.click('[data-fitness-action="continue"]');
  assert.equal(app.document.querySelector('#set-form').elements.reps.value,'11');
  await app.click('[data-fitness-action="finish-incomplete"]');
  await app.click('[data-fitness-action="start"]');
  assert.equal(app.document.querySelector('#set-form').elements.reps.value,'');
});

test('cross-month summary link opens the month and day of that workout',async()=>{
  const app=await createAppHarness({at:'2026-09-30T23:55:00+08:00',beforeStart:training});
  app.advance(600);await app.click('[data-fitness-action="finish-incomplete"]');
  await app.click('[data-fitness-action="next-month"]');
  await app.click('[data-fitness-action="summary-stats"]');
  assert.match(app.document.querySelector('#stats-month').textContent,/9月/);
  assert.match(app.document.querySelector('#fitness-day-detail').textContent,/推日/);
  assert.equal(app.document.querySelector('#fitness-stats-panel').hidden,false);
});

test('legacy exported warmup ordering collisions import without dropping records',async()=>{
  const app=await createAppHarness();
  await app.db.saveWarmup({name:'A',type:'reps',target_value:10});
  await app.db.saveWarmup({name:'B',type:'seconds',target_value:30});
  const backup=JSON.parse(JSON.stringify(await app.db.exportData()));
  for(const w of backup.warmups)w.sort_order=1;
  await app.db.importData(backup);
  const state=await app.db.listState();
  assert.equal(state.warmups.length,2);
  assert.deepEqual([...state.warmups].map(w=>w.sort_order),[0,1]);
  assert.doesNotThrow(()=>app.db.validateBackup({...backup,warmups:state.warmups}));
});

test('invalid JSON sections return a useful import error without replacing data',async()=>{
  const app=await createAppHarness();
  await app.db.saveThought('保留');
  const backup=JSON.parse(JSON.stringify(await app.db.exportData()));
  backup.workoutSessions=[null];
  await assert.rejects(app.db.importData(backup),/备份.*workoutSessions/);
  assert.equal((await app.db.listState()).thoughts[0].content,'保留');
});

test('normal completed training restarts as a summary without an editable page or recovery marker',async()=>{
  const app=await createAppHarness({beforeStart:async({db,storage})=>{
    storage.set('zuocai.activeWorkoutSession',await db.startWorkout(await db.saveFitnessPlan({name:'完成测试',exercises:[exercise('A',1,0)]})));
  }});
  app.advance(120);await app.submit({reps:10,weight:50,rir:2});
  assert.equal(app.storage.has('zuocai.activeWorkoutSession'),false);
  app.dispose();
  const restarted=await createAppHarness({database:app.database,storage:app.storage,at:'2026-10-01T08:03:00Z'});
  assert.equal(restarted.document.querySelector('#workout-dialog').open,false);
  assert.match(restarted.document.querySelector('#fitness-current').textContent,/完成测试/);
  assert.match(restarted.document.querySelector('#fitness-current').textContent,/已完成/);
  assert.match(restarted.document.querySelector('#fitness-current').textContent,/2分/);
  assert.match(restarted.document.querySelector('#fitness-current').textContent,/1 组/);
  assert.equal((await restarted.db.listState()).workoutSets.length,1);
});

test('drafts remain independent by exercise and clear after the corresponding group is saved',async()=>{
  const app=await createAppHarness({beforeStart:async({db,storage})=>{
    storage.set('zuocai.activeWorkoutSession',await db.startWorkout(await db.saveFitnessPlan({name:'双动作',exercises:[exercise('A',3,0),exercise('B',3,0)]})));
  }});
  app.document.querySelector('#set-form').elements.reps.value='11';
  await app.click('[data-fitness-action="select-exercise"][data-index="1"]');
  app.document.querySelector('#set-form').elements.reps.value='7';
  await app.click('[data-fitness-action="select-exercise"][data-index="0"]');
  assert.equal(app.document.querySelector('#set-form').elements.reps.value,'11');
  await app.submit({reps:11,weight:50,rir:2});
  assert.equal(app.document.querySelector('#set-form').elements.reps.value,'');
  await app.click('[data-fitness-action="select-exercise"][data-index="1"]');
  assert.equal(app.document.querySelector('#set-form').elements.reps.value,'7');
});

test('backup cannot restore rest as both running and paused, and preserves the original data',async()=>{
  const app=await createAppHarness({beforeStart:training});
  await app.submit({reps:10,weight:50,rir:2});
  const backup=JSON.parse(JSON.stringify(await app.db.exportData()));
  backup.workoutSessions[0].rest_paused_seconds=40;
  await assert.rejects(app.db.importData(backup),/训练会话/);
  const state=await app.db.listState();
  assert.equal(state.workoutSessions[0].rest_paused_seconds,null);
  assert.equal(state.workoutSets.length,1);
});

test('recovery selects the actual last set instant even when backup timestamps use different zones',async()=>{
  const app=await createAppHarness({beforeStart:async({db,storage})=>{
    storage.set('zuocai.activeWorkoutSession',await db.startWorkout(await db.saveFitnessPlan({name:'时区',exercises:[exercise('A',2,0)]})));
  }});
  const state=await app.db.listState(),ex=state.workoutExercises[0];
  await app.db.saveWorkoutSet({workout_exercise_id:ex.id,set_number:1,actual_reps:10,actual_weight:50});
  await app.db.saveWorkoutSet({workout_exercise_id:ex.id,set_number:2,actual_reps:9,actual_weight:50});
  const backup=JSON.parse(JSON.stringify(await app.db.exportData()));
  backup.workoutSessions[0].started_at='2026-10-01T22:55:00+08:00';
  backup.workoutSets[0].completed_at='2026-10-01T23:00:00+08:00';
  backup.workoutSets[1].completed_at='2026-10-01T15:05:00Z';
  await app.db.importData(backup);
  const restored=(await app.db.listState()).workoutSessions[0];
  assert.equal(restored.status,'completed');
  assert.equal(Date.parse(restored.ended_at),Date.parse('2026-10-01T15:05:00Z'));
});

test('archiving the recent training removes the summary link to hidden statistics',async()=>{
  const app=await createAppHarness({beforeStart:training});
  await app.click('[data-fitness-action="finish-incomplete"]');
  await app.click('[data-fitness-action="summary-stats"]');
  await app.click('#fitness-day-detail [data-fitness-action="archive-workout"]');
  assert.equal(app.document.querySelector('[data-fitness-action="summary-stats"]'),null);
  assert.equal((await app.db.listState()).workoutSessions[0].archived,true);
});

test('conflict override catches save failures, keeps input, and can be retried without duplicates',async()=>{
  let fail=false;
  const app=await createAppHarness({intercept:async(kind,sql)=>{
    if(fail&&kind==='run'&&sql.startsWith('INSERT INTO tasks'))throw new Error('模拟存储失败');
  }});
  await app.click('[data-action="new-task"]');
  const form=app.document.querySelector('#task-form');
  form.elements.title.value='早餐时间任务';form.elements.estimated_minutes.value='30';
  await app.click('.date-choice[data-date="2026-10-01"]');
  app.document.querySelector('.date-start-time[data-date="2026-10-01"]').value='07:30';
  form.dispatchEvent(new app.window.Event('submit',{bubbles:true,cancelable:true}));await app.flush();
  assert.equal(app.document.querySelector('#conflict-dialog').open,true);
  fail=true;await app.click('#force-save');
  assert.match(app.document.querySelector('#toast').textContent,/模拟存储失败/);
  assert.equal(app.document.querySelector('#task-dialog').open,true);
  assert.equal(form.elements.title.value,'早餐时间任务');
  assert.equal(app.document.querySelector('#conflict-dialog').open,true);
  fail=false;
  const button=app.document.querySelector('#force-save');button.click();button.click();await app.flush();
  assert.equal((await app.db.listState()).tasks.length,1);
  assert.equal(app.document.querySelector('#conflict-dialog').open,false);
});
