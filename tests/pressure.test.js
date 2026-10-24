import test from 'node:test';
import assert from 'node:assert/strict';
import { pressureSummary, routineCapacity, remainingCapacity, todayPendingItems, workingIntervals } from '../src/pressure.js';

const today = '2026-09-21';
const routine = { sleep_start:'23:00', wake_time:'07:00', breakfast_start:'07:30', breakfast_end:'08:00', lunch_start:'12:00', lunch_end:'13:00', dinner_start:'18:00', dinner_end:'19:00', rest_minutes_per_hour:'10' };
const at = time => new Date(`${today}T${time}:00`);
const task = (id, changes={}) => ({ id, title:id, deadline:null, estimated_minutes:60, importance:'medium', completed_at:null, ...changes });
const plan = (task_id, changes={}) => ({ task_id, plan_date:today, completed_at:null, ...changes });

test('whole day excludes sleep and meals once, then adds 50/10 cycles', () => {
  assert.deepEqual(routineCapacity(routine), { sleep:480, meals:150, rest:130, available:680 });
  const periods = workingIntervals(routine);
  assert.deepEqual(periods.work.slice(0,2), [{start:420,end:450},{start:480,end:530}]);
  assert.deepEqual(periods.breaks[0], {start:530,end:540});
  assert.deepEqual(periods.work.find(x=>x.start===780), {start:780,end:830});
});

test('fixed local times: dawn, wake, meals, every break edge, bedtime and midnight', () => {
  const periods = workingIntervals(routine);
  const points = ['00:00','06:59','07:00','07:30','07:45','08:00','11:59','12:00','12:30','13:00','18:00','18:30','19:00','22:59','23:00','23:59'];
  for (const time of points) {
    const current = at(time);
    const minute = current.getHours()*60+current.getMinutes();
    const expected = periods.work.reduce((n,x)=>n+Math.max(0,x.end-Math.max(x.start,minute)),0);
    assert.equal(remainingCapacity(routine,current),expected,time);
  }
  assert.equal(remainingCapacity(routine,at('00:00')),680);
  assert.equal(remainingCapacity(routine,at('07:00')),680);
  assert.equal(remainingCapacity(routine,at('07:30')),650);
  assert.equal(remainingCapacity(routine,at('08:00')),650);
  assert.equal(remainingCapacity(routine,at('08:50')),600);
  assert.equal(remainingCapacity(routine,at('09:00')),600);
  assert.equal(remainingCapacity(routine,at('12:00')),450);
  assert.equal(remainingCapacity(routine,at('13:00')),450);
  assert.equal(remainingCapacity(routine,at('18:00')),200);
  assert.equal(remainingCapacity(routine,at('19:00')),200);
  assert.equal(remainingCapacity(routine,at('22:50')),0);
  assert.equal(remainingCapacity(routine,at('23:00')),0);
  for (const x of periods.breaks) {
    const date = minute => new Date(2026,8,21,Math.floor(minute/60),minute%60);
    assert.equal(remainingCapacity(routine,date(x.start)),remainingCapacity(routine,date(x.end)),`rest ${x.start}`);
  }
});

test('cross midnight sleep is split by calendar date, including sleep after midnight', () => {
  const shifted = {...routine,sleep_start:'01:00',wake_time:'08:00',breakfast_start:'08:30',breakfast_end:'09:00'};
  const intervals = workingIntervals(shifted);
  assert.deepEqual(intervals.excluded[0],{start:60,end:480});
  assert.equal(remainingCapacity(shifted,at('01:00')),680);
  assert.equal(remainingCapacity(shifted,at('00:00')),730);
  assert.equal(remainingCapacity(shifted,at('08:00')),routineCapacity(shifted).available-50);
});

test('configurable break minutes and meal resets the cycle', () => {
  const changed = {...routine,rest_minutes_per_hour:'20'};
  assert.deepEqual(workingIntervals(changed).work.find(x=>x.start===480),{start:480,end:520});
  assert.deepEqual(workingIntervals(changed).work.find(x=>x.start===780),{start:780,end:820});
  assert.ok(routineCapacity(changed).available<routineCapacity(routine).available);
  assert.throws(()=>workingIntervals({...routine,rest_minutes_per_hour:'60'}));
});

test('one pending list drives full minutes and score with due, overdue and duplicate ownership', () => {
  const tasks=[task('planned',{deadline:today,importance:'high'}),task('due',{deadline:today}),task('overdue',{deadline:'2026-09-20'}),task('done',{deadline:today,completed_at:'done'}),task('planDone',{deadline:today}),task('future',{deadline:'2026-09-22'}),task('futurePlanned',{deadline:today})];
  const plans=[plan('planned'),plan('planDone',{completed_at:'done'}),plan('futurePlanned',{plan_date:'2026-09-22'})];
  const items=todayPendingItems(tasks,plans,today);
  assert.deepEqual(items.map(x=>x.task.id),['planned','due','overdue']);
  const result=pressureSummary(tasks,plans,today,300);
  assert.equal(result.taskMinutes,180);
  assert.equal(result.plannedMinutes,60);
  assert.equal(result.score,60);
  assert.equal(result.highCount,1);
  assert.equal(result.overdueCount,1);
  assert.equal(Math.max(0,result.remainingMinutes-result.plannedMinutes),240);
});

test('zero capacity, overflow, no tasks and time of day use exact minutes', () => {
  const tasks=[task('a',{estimated_minutes:180})],plans=[plan('a')];
  assert.deepEqual([pressureSummary(tasks,plans,today,120).score,pressureSummary(tasks,plans,today,120).overMinutes],[100,60]);
  assert.deepEqual([pressureSummary(tasks,plans,today,0).score,pressureSummary(tasks,plans,today,0).overMinutes],[100,180]);
  assert.equal(pressureSummary([],[],today,0).score,0);
  assert.ok(pressureSummary(tasks,plans,today,remainingCapacity(routine,at('19:00'))).score > pressureSummary(tasks,plans,today,remainingCapacity(routine,at('08:00'))).score);
});

test('foreground and next calendar day calculations use fresh clock and date', () => {
  const tasks=[task('a',{deadline:today})];
  const morning=pressureSummary(tasks,[],today,remainingCapacity(routine,at('08:00')));
  const evening=pressureSummary(tasks,[],today,remainingCapacity(routine,at('22:00')));
  const nextDay='2026-09-22';
  const next=pressureSummary(tasks,[],nextDay,remainingCapacity(routine,new Date('2026-09-22T00:01:00')));
  assert.ok(evening.score>morning.score);
  assert.equal(next.items[0].source,'overdue');
  assert.equal(next.remainingMinutes,680);
});
