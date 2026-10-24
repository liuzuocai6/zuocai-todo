import test from 'node:test';
import assert from 'node:assert/strict';
import { overlapMinutes, findPlanConflicts, classifyHome, assignOverlapLanes, gaugeAngle, routineIntervals } from '../src/logic.js';
import { daysBetween } from '../src/pressure.js';
import { readFileSync } from 'node:fs';

const routine={sleep_start:'23:00',wake_time:'07:00',breakfast_start:'07:30',breakfast_end:'08:00',lunch_start:'12:00',lunch_end:'13:00',dinner_start:'18:00',dinner_end:'19:00'};
const task=(id,changes={})=>({id,title:id,estimated_minutes:30,importance:'medium',deadline:null,is_long_term:false,completed_at:null,...changes});

test('touching intervals do not conflict',()=>assert.equal(overlapMinutes(60,120,120,180),0));
test('routine and task conflicts are reported but self is excluded',()=>{
  const tasks=[task('a',{estimated_minutes:60}),task('b',{estimated_minutes:60})];
  const plans=[{id:'self',task_id:'a',plan_date:'2026-09-21',start_time:'12:00',completed_at:null},{id:'other',task_id:'b',plan_date:'2026-09-21',start_time:'12:30',completed_at:null}];
  const result=findPlanConflicts({plan_id:'self',plan_date:'2026-09-21',start_time:'12:00',estimated_minutes:60},tasks,plans,routine);
  assert.equal(result.some(item=>item.label==='午餐'),true);
  assert.equal(result.some(item=>item.label.includes('b')),true);
  assert.equal(result.some(item=>item.label.includes('a')),false);
});
test('home sections are mutually exclusive',()=>{
  const today='2026-09-21', tasks=[task('today'),task('due',{deadline:'2026-09-22'}),task('future'),task('free'),task('goal',{is_long_term:true})];
  const plans=[{task_id:'today',plan_date:today,completed_at:null},{task_id:'future',plan_date:'2026-09-23',completed_at:null}];
  const result=classifyHome(tasks,plans,today,daysBetween);
  assert.deepEqual(result.todayPlans.map(x=>x.task_id),['today']);
  assert.deepEqual(result.upcoming.map(x=>x.id),['due','future']);
  assert.deepEqual(result.unscheduled.map(x=>x.id),['free']);
});
test('expired plan becomes unscheduled',()=>{const result=classifyHome([task('a')],[{task_id:'a',plan_date:'2026-09-20',completed_at:null}],'2026-09-21',daysBetween);assert.equal(result.unscheduled[0].plan_expired,true);});
test('overlapping events receive separate lanes',()=>{const result=assignOverlapLanes([{id:'a',start:60,end:180},{id:'b',start:120,end:240},{id:'c',start:140,end:160}]);assert.equal(new Set(result.map(x=>x.lane)).size,3);assert.ok(result.every(x=>x.lanes===3));});
test('gauge angles map left, top and right',()=>{assert.equal(gaugeAngle(0),-180);assert.equal(gaugeAngle(50),-90);assert.equal(gaugeAngle(100),0);});
test('same-day sleep does not become an all-day conflict',()=>{const intervals=routineIntervals({...routine,sleep_start:'01:00',wake_time:'08:00'}).filter(x=>x.label==='睡觉');assert.deepEqual(intervals,[{label:'睡觉',start:60,end:480}]);});
test('required page elements exist exactly once',()=>{
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  for(const id of ['today-list','upcoming-list','unscheduled-list','pressure-capacity','pressure-free','history-list','archived-plan-list','archived-workout-list','schedule','goal-list','thought-list','fitness-plan-picker','export-workout-stats','workout-dialog','task-form','conflict-dialog','import-dialog']) assert.equal((html.match(new RegExp(`id="${id}"`,'g'))||[]).length,1,id);
  const app=readFileSync(new URL('../src/app.js',import.meta.url),'utf8');
  assert.match(app,/archive-workout/);
  assert.match(app,/restore-workout/);
  assert.doesNotMatch(app,/class="drag-handle"/);
  for(const page of ['today','schedule','goals','fitness','settings']) assert.equal((html.match(new RegExp(`data-page="${page}"`,'g'))||[]).length,1,page);
});
