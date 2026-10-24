import { validateRoutine } from './data-validation.js';
export const BACKUP_VERSION = 4;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const time = /^([01]\d|2[0-3]):[0-5]\d$/;
const arrays = ['tasks','plans','thoughts','fitnessPlans','fitnessExercises','warmups','workoutSessions','workoutExercises','workoutSets'];
const fitnessArrays = arrays.slice(3);
function fail(section) { throw new Error(`备份中的${section}数据无效。`); }
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0,10) === value;
}
function stamp(value, nullable=false) { return nullable && value == null || typeof value === 'string' && !Number.isNaN(Date.parse(value)); }
function numeric(value, min, max, integer=false, nullable=false) {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return nullable && value == null || typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= min && parsed <= max && (!integer || Number.isInteger(parsed));
}
function numberField(value) {
  return typeof value === 'number' || typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
}
function numberOrNull(value) { return value == null || value === '' ? null : numberField(value); }
function ids(items, label) {
  const seen = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'object' || !uuid.test(item.id || '') || seen.has(item.id)) fail(label);
    seen.add(item.id);
  }
  return seen;
}
function text(value, required=false) { return typeof value === 'string' && (!required || !!value.trim()); }
function exercise(value, snapshot=false) {
  if (!text(value.name,true) || !text(value.muscle_group || '') || !text(value.notes || '') ||
    !numeric(value.sort_order,0,100000,true) || !numeric(value.recommended_sets,1,100,true) ||
    !numeric(value.recommended_reps_min,1,1000,true) || !numeric(value.recommended_reps_max,1,1000,true) ||
    Number(value.recommended_reps_min) > Number(value.recommended_reps_max) || !numeric(value.recommended_weight,0,10000) ||
    !numeric(value.recommended_rir,0,10,false,true) || !numeric(value.rest_seconds,0,3600,true) ||
    !snapshot && (!stamp(value.created_at) || !stamp(value.updated_at))) fail(snapshot?'训练动作快照':'计划动作');
}
export function validateBackup(value, routineKeys) {
  if (!value || typeof value !== 'object' || ![1,2,3,4].includes(Number(value.schema_version)) ||
    !Array.isArray(value.tasks) || !Array.isArray(value.plans) || !Array.isArray(value.thoughts) ||
    !value.routine || typeof value.routine !== 'object') throw new Error('备份文件格式或版本不受支持。');
  const backup = {...value, schema_version:BACKUP_VERSION};
  for (const key of fitnessArrays) {
    if (Number(value.schema_version) < 3 && value[key] == null) backup[key] = [];
    else if (!Array.isArray(value[key])) throw new Error(`备份缺少或损坏 ${key}。`);
  }
  // Reject malformed rows before field normalization accesses their properties.
  for (const key of arrays) {
    if (backup[key].some(row => !row || typeof row !== 'object' || Array.isArray(row))) fail(key);
  }
  backup.workoutSessions = backup.workoutSessions.map(session=>({
    ...session,
    archived:Number(value.schema_version)<4 && session.archived == null ? 0 : session.archived
  }));
  backup.workoutSets = backup.workoutSets.map(set=>({...set,
    set_number:numberField(set.set_number),
    actual_reps:numberField(set.actual_reps),
    actual_weight:numberField(set.actual_weight),
    actual_rir:numberOrNull(set.actual_rir)
  }));
  // SQLite and old exports can contain numeric strings. Normalize every
  // persisted numeric field once, before comparing ranges or importing rows.
  for (const key of ['fitnessExercises','workoutExercises']) backup[key]=backup[key].map(row=>({...row,
    sort_order:numberField(row.sort_order),recommended_sets:numberField(row.recommended_sets),
    recommended_reps_min:numberField(row.recommended_reps_min),recommended_reps_max:numberField(row.recommended_reps_max),
    recommended_weight:numberField(row.recommended_weight),recommended_rir:numberOrNull(row.recommended_rir),rest_seconds:numberField(row.rest_seconds)
  }));
  backup.tasks=backup.tasks.map(task=>({...task,estimated_minutes:numberField(task.estimated_minutes)}));
  backup.warmups=backup.warmups.map(row=>({...row,sort_order:numberField(row.sort_order),target_value:numberField(row.target_value)}));
  backup.workoutSessions=backup.workoutSessions.map(row=>({...row,current_exercise:numberField(row.current_exercise),current_set:numberField(row.current_set),rest_paused_seconds:row.rest_paused_seconds==null?null:numberField(row.rest_paused_seconds)}));
  const all = Object.fromEntries(arrays.map(key=>[key,ids(backup[key],key)]));
  const taskMap = new Map(backup.tasks.map(task=>[task.id,task]));
  for (const task of backup.tasks) {
    if (!text(task.title,true) || !numeric(task.estimated_minutes,1,1440,true) || !['low','medium','high'].includes(task.importance) ||
      ![0,1,false,true].includes(task.is_long_term) || !Array.isArray(task.tags) || task.tags.some(tag=>!text(tag)) || task.deadline != null && !date(task.deadline) ||
      !stamp(task.created_at) || !stamp(task.updated_at) || !stamp(task.completed_at,true)) fail('事项');
  }
  const taskDates = new Set(), planCounts = new Map();
  for (const plan of backup.plans) {
    const key = `${plan.task_id}:${plan.plan_date}`;
    if (!all.tasks.has(plan.task_id) || !date(plan.plan_date) || plan.start_time != null && !time.test(plan.start_time) ||
      !stamp(plan.created_at) || !stamp(plan.updated_at) || !stamp(plan.completed_at,true) || taskDates.has(key)) fail('日程');
    taskDates.add(key); planCounts.set(plan.task_id,(planCounts.get(plan.task_id)||0)+1);
  }
  for (const [id,count] of planCounts) if (!taskMap.get(id).is_long_term && count > 1) fail('日程');
  for (const thought of backup.thoughts) if (!text(thought.content,true) || !stamp(thought.created_at) || !stamp(thought.updated_at)) fail('想法');
  backup.routine = {...backup.routine};
  if (backup.routine.rest_minutes_per_hour == null) backup.routine.rest_minutes_per_hour = '10';
  for (const key of routineKeys) {
    if (key === 'rest_minutes_per_hour') {
      const rest = Number(backup.routine[key]);
      if (!/^\d{1,2}$/.test(String(backup.routine[key])) || !Number.isInteger(rest) || rest < 0 || rest > 59) fail('作息');
    } else if (!time.test(backup.routine[key] || '')) fail('作息');
  }
  try { validateRoutine(backup.routine); } catch { fail('作息'); }
  for (const plan of backup.fitnessPlans) if (!text(plan.name,true) || !text(plan.notes || '') || !stamp(plan.created_at) || !stamp(plan.updated_at) || ![0,1,false,true].includes(plan.archived)) fail('训练计划');
  const planOrders = new Set();
  for (const exerciseRow of backup.fitnessExercises) {
    exercise(exerciseRow);
    if (!all.fitnessPlans.has(exerciseRow.plan_id)) fail('计划动作');
    const key = `${exerciseRow.plan_id}:${exerciseRow.sort_order}`;
    if (planOrders.has(key)) fail('计划动作'); planOrders.add(key);
  }
  for (const warmup of backup.warmups) {
    if (!text(warmup.name,true) || !text(warmup.notes || '') || !['reps','seconds'].includes(warmup.type) ||
      !numeric(warmup.target_value,1,100000,true) || !numeric(warmup.sort_order,0,100000,true) ||
      !stamp(warmup.created_at) || !stamp(warmup.updated_at)) fail('热身');
  }
  // Earlier App versions could export duplicate warmup positions. Order is a
  // presentation field: normalize it deterministically without losing actions.
  backup.warmups = [...backup.warmups].sort((a,b) => a.sort_order-b.sort_order || a.id.localeCompare(b.id))
    .map((row,index) => ({...row,sort_order:index}));
  for (const session of backup.workoutSessions) {
    if (session.plan_id != null && !all.fitnessPlans.has(session.plan_id) || !text(session.plan_name,true) ||
      !['in_progress','completed','incomplete'].includes(session.status) || !stamp(session.started_at) ||
      !stamp(session.ended_at,true) || !stamp(session.rest_end_at,true) || !numeric(session.rest_paused_seconds,0,3600,true,true) || !stamp(session.created_at) || !stamp(session.updated_at) ||
      !numeric(session.current_exercise,0,100000,true) || !numeric(session.current_set,1,100,true) ||
      ![0,1,false,true].includes(session.archived) || session.status==='in_progress' && Boolean(session.archived) ||
      session.rest_end_at != null && session.rest_paused_seconds != null ||
      session.status==='in_progress' && session.ended_at != null || session.status!=='in_progress' && !stamp(session.ended_at) ||
      session.ended_at && Date.parse(session.ended_at)<Date.parse(session.started_at)) fail('训练会话');
  }
  if(backup.workoutSessions.filter(session=>session.status==='in_progress').length>1)fail('训练会话');
  const snapshotOrders = new Set(), snapshotMap = new Map();
  for (const row of backup.workoutExercises) {
    exercise(row,true); if (!all.workoutSessions.has(row.session_id)) fail('训练动作快照');
    const key = `${row.session_id}:${row.sort_order}`; if (snapshotOrders.has(key)) fail('训练动作快照'); snapshotOrders.add(key);snapshotMap.set(row.id,row);
  }
  const setOrders = new Set();
  for (const set of backup.workoutSets) {
    const ex = snapshotMap.get(set.workout_exercise_id), key = `${set.workout_exercise_id}:${set.set_number}`;
    if (!ex || !numeric(set.set_number,1,ex.recommended_sets,true) || !numeric(set.actual_reps,1,1000,true) ||
      !numeric(set.actual_weight,0,10000) || !numeric(set.actual_rir,0,10,false,true) || !stamp(set.completed_at) || setOrders.has(key)) fail('训练组');
    setOrders.add(key);
  }
  for(const session of backup.workoutSessions.filter(session=>session.status==='in_progress')){
    const exercises=backup.workoutExercises.filter(row=>row.session_id===session.id).sort((a,b)=>a.sort_order-b.sort_order);
    if(!exercises.length || exercises.some((row,index)=>row.sort_order!==index) || session.current_exercise>=exercises.length || session.current_set>exercises[session.current_exercise].recommended_sets)fail('训练会话');
  }
  for(const exercise of backup.workoutExercises){
    const groups=backup.workoutSets.filter(row=>row.workout_exercise_id===exercise.id).sort((a,b)=>a.set_number-b.set_number);
    if(groups.some((row,index)=>row.set_number!==index+1))fail('训练组');
  }
  return backup;
}
