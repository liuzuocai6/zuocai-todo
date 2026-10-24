import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBackup } from '../src/backup-validation.js';
import { DEFAULT_ROUTINE } from '../src/db.js';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const stamp='2026-09-27T08:00:00.000Z';
const routine={sleep_start:'23:00',wake_time:'07:00',breakfast_start:'07:30',breakfast_end:'08:00',lunch_start:'12:00',lunch_end:'13:00',dinner_start:'18:00',dinner_end:'19:00'};
const base=()=>({schema_version:3,tasks:[],plans:[],thoughts:[],routine,fitnessPlans:[],fitnessExercises:[],warmups:[],workoutSessions:[],workoutExercises:[],workoutSets:[]});
const check=v=>validateBackup(v,Object.keys(DEFAULT_ROUTINE));
const task=()=>({id:id(1),title:'任务',deadline:null,estimated_minutes:30,importance:'medium',tags:[],is_long_term:false,created_at:stamp,updated_at:stamp,completed_at:null});
const plan=()=>({id:id(2),name:'推日',notes:'',created_at:stamp,updated_at:stamp,archived:0});
const exercise=()=>({id:id(3),plan_id:id(2),sort_order:0,name:'卧推',muscle_group:'胸',notes:'',recommended_sets:3,recommended_reps_min:8,recommended_reps_max:12,recommended_weight:50,recommended_rir:2,rest_seconds:90,created_at:stamp,updated_at:stamp});
test('empty schema 3 backup and old backup normalize',()=>{assert.equal(check(base()).schema_version,4);const old={schema_version:2,tasks:[],plans:[],thoughts:[],routine};assert.deepEqual(check(old).fitnessPlans,[]);assert.equal(check(old).routine.rest_minutes_per_hour,'10')});
test('new rest setting is validated in backups',()=>{const b=base();b.routine={...routine,rest_minutes_per_hour:'20'};assert.equal(check(b).routine.rest_minutes_per_hour,'20');b.routine.rest_minutes_per_hour='60';assert.throws(()=>check(b),/作息/)});
test('todo backup accepts valid IDs and rejects duplicates',()=>{const b=base();b.tasks=[task()];assert.equal(check(b).tasks.length,1);b.tasks.push(task());assert.throws(()=>check(b),/tasks/)});
test('fitness backup checks references and rep ranges',()=>{const b=base();b.fitnessPlans=[plan()];b.fitnessExercises=[exercise()];assert.equal(check(b).fitnessExercises.length,1);b.fitnessExercises[0].recommended_reps_min=13;assert.throws(()=>check(b),/计划动作/);b.fitnessExercises[0].recommended_reps_min=8;b.fitnessExercises[0].plan_id=id(99);assert.throws(()=>check(b),/计划动作/)});
test('schema 3 rejects missing fitness sections',()=>{const b=base();delete b.workoutSets;assert.throws(()=>check(b),/workoutSets/)});
test('schema 3 workout history defaults to unarchived, schema 4 validates archive state',()=>{const b=base();b.workoutSessions=[{id:id(4),plan_id:null,plan_name:'推日',started_at:stamp,ended_at:stamp,status:'completed',current_exercise:0,current_set:1,rest_end_at:null,rest_paused_seconds:null,created_at:stamp,updated_at:stamp}];assert.equal(check(b).workoutSessions[0].archived,0);b.schema_version=4;b.workoutSessions[0].archived=1;assert.equal(check(b).workoutSessions[0].archived,1);b.workoutSessions[0].archived='yes';assert.throws(()=>check(b),/训练会话/);b.workoutSessions[0].archived=1;b.workoutSessions[0].status='in_progress';assert.throws(()=>check(b),/训练会话/)});
test('exported numeric strings in workout sets are normalized',()=>{const b=base();b.workoutSessions=[{id:id(4),plan_id:null,plan_name:'推日',started_at:stamp,ended_at:stamp,status:'completed',current_exercise:0,current_set:1,rest_end_at:null,rest_paused_seconds:null,created_at:stamp,updated_at:stamp}];b.workoutExercises=[{id:id(5),session_id:id(4),sort_order:0,name:'卧推',muscle_group:'胸',notes:'',recommended_sets:3,recommended_reps_min:8,recommended_reps_max:12,recommended_weight:50,recommended_rir:2,rest_seconds:90}];b.workoutSets=[{id:id(6),workout_exercise_id:id(5),set_number:'1',actual_reps:'10',actual_weight:'50',actual_rir:'2',completed_at:stamp}];const normalized=check(b);assert.equal(normalized.workoutSets[0].actual_reps,10);assert.equal(normalized.workoutSets[0].actual_weight,50);assert.equal(normalized.workoutSets[0].actual_rir,2)});

test('required numeric fields never turn null, empty strings or booleans into valid zero values',()=>{
  for(const value of [null,undefined,'',' ',false,true]){
    for(const key of ['sort_order','recommended_weight','rest_seconds']){
      const b=base();b.fitnessPlans=[plan()];b.fitnessExercises=[{...exercise(),[key]:value}];
      assert.throws(()=>check(b),/计划动作/);
    }
  }
  const b=base();b.fitnessPlans=[plan()];b.fitnessExercises=[{...exercise(),sort_order:'0',recommended_weight:'0',rest_seconds:'0'}];
  assert.equal(check(b).fitnessExercises[0].recommended_weight,0);
});
