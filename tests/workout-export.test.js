import test from 'node:test';
import assert from 'node:assert/strict';
import { workoutStatsRows, workoutStatsCsv } from '../src/workout-export.js';

test('CSV exports only ended unarchived history, one row per set with duration and snapshot',()=>{
  const sessions=[{id:'s1',started_at:'2026-09-28T23:40:00+08:00',ended_at:'2026-09-29T00:55:00+08:00',status:'completed',archived:true,plan_name:'推日, A'},{id:'s2',started_at:'2026-09-29T10:00:00+08:00',ended_at:null,status:'in_progress',archived:false,plan_name:'进行中'}];
  const exercises=[{id:'e1',session_id:'s1',sort_order:0,name:'卧推',muscle_group:'胸',recommended_sets:3,recommended_reps_min:8,recommended_reps_max:12,recommended_weight:50,recommended_rir:2,rest_seconds:90},{id:'e2',session_id:'s1',sort_order:1,name:'飞鸟',muscle_group:'胸',recommended_sets:2,recommended_reps_min:10,recommended_reps_max:12,recommended_weight:10,recommended_rir:1,rest_seconds:60}];
  const sets=[{workout_exercise_id:'e1',set_number:1,actual_reps:10,actual_weight:50,actual_rir:2,completed_at:'2026-09-28T23:50:00+08:00'},{workout_exercise_id:'e1',set_number:2,actual_reps:8,actual_weight:55,actual_rir:1,completed_at:'2026-09-29T00:10:00+08:00'}];
  sessions[0].archived=false;
  const rows=workoutStatsRows(sessions,exercises,sets);
  assert.equal(rows.length,3);
  assert.deepEqual(rows[0].slice(3,6),[75,'completed','推日, A']);
  assert.deepEqual(rows[0].slice(-6),[1,10,50,2,'2026-09-28T23:50:00+08:00',500]);
  assert.equal(rows[1].at(-1),440);
  assert.equal(rows[2][7],'飞鸟');
  assert.equal(rows[2][15],'');
  const csv=workoutStatsCsv(sessions,exercises,sets);
  assert.match(csv,/"推日, A"/);
  assert.equal(csv.split('\r\n').length,4);
  sessions[0].archived=true;
  assert.equal(workoutStatsRows(sessions,exercises,sets).length,0);
});
