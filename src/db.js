import { Capacitor } from '@capacitor/core';
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
import { validateBackup as validateBackupPayload } from './backup-validation.js';
import { validateRoutine, validateTask, validateExercise, validateSet, requireText, requireNumber } from './data-validation.js';
export const DEFAULT_ROUTINE = { sleep_start: '23:00', wake_time: '07:00', breakfast_start: '07:30', breakfast_end: '08:00', lunch_start: '12:00', lunch_end: '13:00', dinner_start: '18:00', dinner_end: '19:00', rest_minutes_per_hour: '10' };
export const SCHEMA_VERSION = 4;
const sqlite = new SQLiteConnection(CapacitorSQLite);
let db;
const now = () => new Date().toISOString();
const rowValue = (r, k) => r?.[k] ?? null;
const uuid = () => globalThis.crypto?.randomUUID?.() || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 3) | 8; return v.toString(16); });
async function rows(sql, values = []) { return (await db.query(sql, values)).values || []; }
async function _initializeDatabase() {
    if (!Capacitor.isNativePlatform())
        throw new Error('本地数据库只能在 Android App 中运行。');
    const consistency = await sqlite.checkConnectionsConsistency(), connected = await sqlite.isConnection('local_todo', false);
    db = consistency.result && connected.result ? await sqlite.retrieveConnection('local_todo', false) : await sqlite.createConnection('local_todo', false, 'no-encryption', SCHEMA_VERSION, false);
    await db.open();
    const vr = (await db.query('PRAGMA user_version')).values?.[0] || {}, stored = Number(vr.user_version ?? Object.values(vr)[0] ?? 0);
    if (stored > SCHEMA_VERSION)
        throw new Error(`数据库版本 ${stored} 比当前 App 支持的版本 ${SCHEMA_VERSION} 更新。为保护数据，已停止打开。`);
    await db.execute(`CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,title TEXT NOT NULL,deadline TEXT,estimated_minutes INTEGER NOT NULL,importance TEXT NOT NULL,tags_json TEXT NOT NULL DEFAULT '[]',is_long_term INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,completed_at TEXT);
 CREATE TABLE IF NOT EXISTS task_plans(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,plan_date TEXT NOT NULL,start_time TEXT,completed_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(task_id,plan_date));
 CREATE TABLE IF NOT EXISTS thoughts(id TEXT PRIMARY KEY,content TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS notification_registry(notification_id INTEGER PRIMARY KEY,task_id TEXT NOT NULL,plan_id TEXT,kind TEXT NOT NULL,scheduled_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS fitness_plans(id TEXT PRIMARY KEY,name TEXT NOT NULL,notes TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,archived INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS fitness_exercises(id TEXT PRIMARY KEY,plan_id TEXT NOT NULL REFERENCES fitness_plans(id) ON DELETE CASCADE,sort_order INTEGER NOT NULL,name TEXT NOT NULL,muscle_group TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '',recommended_sets INTEGER NOT NULL,recommended_reps_min INTEGER NOT NULL,recommended_reps_max INTEGER NOT NULL,recommended_weight REAL NOT NULL DEFAULT 0,recommended_rir REAL,rest_seconds INTEGER NOT NULL DEFAULT 90,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(plan_id,sort_order));
 CREATE TABLE IF NOT EXISTS warmups(id TEXT PRIMARY KEY,sort_order INTEGER NOT NULL,name TEXT NOT NULL,type TEXT NOT NULL CHECK(type IN ('reps','seconds')),target_value INTEGER NOT NULL,notes TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS workout_sessions(id TEXT PRIMARY KEY,plan_id TEXT REFERENCES fitness_plans(id) ON DELETE SET NULL,plan_name TEXT NOT NULL,started_at TEXT NOT NULL,ended_at TEXT,status TEXT NOT NULL CHECK(status IN ('in_progress','completed','incomplete')),current_exercise INTEGER NOT NULL DEFAULT 0,current_set INTEGER NOT NULL DEFAULT 1,rest_end_at TEXT,rest_paused_seconds INTEGER,archived INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS workout_exercises(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES workout_sessions(id) ON DELETE CASCADE,sort_order INTEGER NOT NULL,name TEXT NOT NULL,muscle_group TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '',recommended_sets INTEGER NOT NULL,recommended_reps_min INTEGER NOT NULL,recommended_reps_max INTEGER NOT NULL,recommended_weight REAL NOT NULL DEFAULT 0,recommended_rir REAL,rest_seconds INTEGER NOT NULL DEFAULT 90);
 CREATE TABLE IF NOT EXISTS workout_sets(id TEXT PRIMARY KEY,workout_exercise_id TEXT NOT NULL REFERENCES workout_exercises(id) ON DELETE CASCADE,set_number INTEGER NOT NULL,actual_reps INTEGER NOT NULL,actual_weight REAL NOT NULL DEFAULT 0,actual_rir REAL,completed_at TEXT NOT NULL,UNIQUE(workout_exercise_id,set_number));`);
    if (stored === 1)
        await db.run("INSERT OR IGNORE INTO settings(key,value) VALUES('clear_legacy_notifications','1')");
    const sessionColumns = await rows('PRAGMA table_info(workout_sessions)');
    if (!sessionColumns.some(c => c.name === 'rest_paused_seconds'))
        await db.execute('ALTER TABLE workout_sessions ADD COLUMN rest_paused_seconds INTEGER');
    if (!sessionColumns.some(c => c.name === 'archived'))
        await db.execute('ALTER TABLE workout_sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
    // Repair old duplicate/gapped warmup ordering without deleting any actions.
    const orderedWarmups = await rows('SELECT id,sort_order FROM warmups ORDER BY sort_order,id');
    if (orderedWarmups.some((row, index) => Number(row.sort_order) !== index)) {
        await db.beginTransaction();
        try {
            for (const [index, row] of orderedWarmups.entries())
                await db.run('UPDATE warmups SET sort_order=? WHERE id=?', [index, row.id], false);
            await db.commitTransaction();
        }
        catch (error) {
            await db.rollbackTransaction();
            throw error;
        }
    }
    if (stored < SCHEMA_VERSION)
        await db.execute(`PRAGMA user_version=${SCHEMA_VERSION}`);
    await db.run('DELETE FROM settings WHERE key=?', ['schema_version']);
    await db.run('INSERT INTO settings(key,value) VALUES(?,?)', ['schema_version', String(SCHEMA_VERSION)]);
    for (const [k, v] of Object.entries(DEFAULT_ROUTINE))
        await db.run('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)', [k, v]);
    await recoverCompletedWorkouts();
    return db;
}
// Older versions committed the last set before marking the session complete.
// Recover that interrupted second step using the recorded set timestamps.
async function recoverCompletedWorkouts() {
    const candidates = await rows(`SELECT s.id,s.started_at
        FROM workout_sessions s
        WHERE s.status='in_progress' AND s.archived=0
        AND EXISTS(SELECT 1 FROM workout_exercises we WHERE we.session_id=s.id)
        AND NOT EXISTS(SELECT 1 FROM workout_exercises we WHERE we.session_id=s.id
            AND (SELECT COUNT(*) FROM workout_sets ws WHERE ws.workout_exercise_id=we.id)<we.recommended_sets)`);
    for (const session of candidates) {
        const completed = await rows(`SELECT ws.completed_at FROM workout_sets ws
            JOIN workout_exercises we ON we.id=ws.workout_exercise_id
            WHERE we.session_id=?`, [session.id]);
        const stamps = completed.map(row => Date.parse(row.completed_at)).filter(Number.isFinite);
        const end = new Date(Math.max(Date.parse(session.started_at), ...stamps)).toISOString();
        await db.run(`UPDATE workout_sessions SET status='completed',ended_at=?,
            rest_end_at=NULL,rest_paused_seconds=NULL,updated_at=?
            WHERE id=? AND status='in_progress' AND archived=0`, [end, now(), session.id], false);
    }
}
async function _getSetting(k, f = null) { return rowValue((await rows('SELECT value FROM settings WHERE key=?', [k]))[0], 'value') ?? f; }
async function _setSetting(k, v) { await db.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [k, String(v)]); }
async function _deleteSetting(k) { await db.run('DELETE FROM settings WHERE key=?', [k]); }
async function _saveRoutine(r) { validateRoutine({ ...DEFAULT_ROUTINE, ...r }); await db.beginTransaction(); try {
    for (const [k, v] of Object.entries(r))
        if (k in DEFAULT_ROUTINE)
            await db.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [k, String(v)], false);
    await db.commitTransaction();
}
catch (e) {
    await db.rollbackTransaction();
    throw e;
} }
async function _listState() { const tasks = (await rows('SELECT * FROM tasks ORDER BY created_at DESC')).map(t => ({ ...t, is_long_term: Boolean(t.is_long_term), tags: JSON.parse(t.tags_json || '[]') })), plans = await rows('SELECT * FROM task_plans ORDER BY plan_date,start_time,id'), thoughts = await rows('SELECT * FROM thoughts ORDER BY created_at DESC'), routine = {}; for (const [k, f] of Object.entries(DEFAULT_ROUTINE))
    routine[k] = await _getSetting(k, f); const allFitnessPlans = (await rows('SELECT * FROM fitness_plans ORDER BY updated_at DESC')).map(p => ({ ...p, archived: Number(p.archived) === 1, exercises: [] })), ex = await rows('SELECT * FROM fitness_exercises ORDER BY plan_id,sort_order'); for (const e of ex) {
    const p = allFitnessPlans.find(x => x.id === e.plan_id);
    if (p)
        p.exercises.push({ ...e, recommended_weight: Number(e.recommended_weight), recommended_rir: e.recommended_rir == null ? null : Number(e.recommended_rir) });
} return { tasks, plans, thoughts, routine, fitnessPlans: allFitnessPlans.filter(p => !p.archived), archivedFitnessPlans: allFitnessPlans.filter(p => p.archived), warmups: await rows('SELECT * FROM warmups ORDER BY sort_order,id'), workoutSessions: (await rows('SELECT * FROM workout_sessions ORDER BY started_at DESC')).map(s => ({ ...s, archived: Number(s.archived) === 1, rest_paused_seconds: s.rest_paused_seconds == null ? null : Number(s.rest_paused_seconds) })), workoutExercises: await rows('SELECT * FROM workout_exercises ORDER BY session_id,sort_order'), workoutSets: await rows('SELECT * FROM workout_sets ORDER BY workout_exercise_id,set_number') }; }
async function _saveTask(i) { validateTask(i); const t = now(), id = i.id || uuid(); await db.beginTransaction(); try {
    await db.run(`INSERT INTO tasks(id,title,deadline,estimated_minutes,importance,tags_json,is_long_term,created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,deadline=excluded.deadline,estimated_minutes=excluded.estimated_minutes,importance=excluded.importance,tags_json=excluded.tags_json,is_long_term=excluded.is_long_term,updated_at=excluded.updated_at`, [id, i.title.trim(), i.deadline || null, i.estimated_minutes, i.importance, JSON.stringify(i.tags || []), i.is_long_term ? 1 : 0, i.created_at || t, t, i.completed_at || null], false);
    const dates = (i.plans || []).map(p => p.plan_date);
    await db.run(`DELETE FROM task_plans WHERE task_id=?${dates.length ? ` AND plan_date NOT IN (${dates.map(() => '?').join(',')})` : ''}`, [id, ...dates], false);
    for (const p of i.plans || [])
        await db.run('INSERT INTO task_plans(id,task_id,plan_date,start_time,completed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(task_id,plan_date) DO UPDATE SET start_time=excluded.start_time,completed_at=excluded.completed_at,updated_at=excluded.updated_at', [p.id || uuid(), id, p.plan_date, p.start_time || null, p.completed_at || null, p.created_at || t, t], false);
    await db.commitTransaction();
    return id;
}
catch (e) {
    await db.rollbackTransaction();
    throw e;
} }
async function _deleteTask(id) { await db.run('DELETE FROM tasks WHERE id=?', [id]); }
async function _removePlan(id) { await db.run('DELETE FROM task_plans WHERE id=?', [id]); }
async function _setTaskCompleted(id, v) { await db.run('UPDATE tasks SET completed_at=?,updated_at=? WHERE id=?', [v ? now() : null, now(), id]); }
async function _setPlanCompleted(id, v) { await db.run('UPDATE task_plans SET completed_at=?,updated_at=? WHERE id=?', [v ? now() : null, now(), id]); }
async function _saveThought(c) { const t = now(); await db.run('INSERT INTO thoughts(id,content,created_at,updated_at) VALUES(?,?,?,?)', [uuid(), c.trim(), t, t]); }
async function _deleteThought(id) { await db.run('DELETE FROM thoughts WHERE id=?', [id]); }
export function validateBackup(value) { return validateBackupPayload(value, Object.keys(DEFAULT_ROUTINE)); }
async function _exportData() { const s = await _listState(); return { schema_version: SCHEMA_VERSION, exported_at: now(), tasks: s.tasks, plans: s.plans, thoughts: s.thoughts, routine: s.routine, fitnessPlans: await rows('SELECT * FROM fitness_plans ORDER BY created_at,id'), fitnessExercises: await rows('SELECT * FROM fitness_exercises ORDER BY plan_id,sort_order'), warmups: s.warmups, workoutSessions: s.workoutSessions, workoutExercises: s.workoutExercises, workoutSets: s.workoutSets }; }
async function _importData(b) { b = validateBackup(b); await db.beginTransaction(); try {
    for (const t of ['notification_registry', 'workout_sets', 'workout_exercises', 'workout_sessions', 'fitness_exercises', 'fitness_plans', 'warmups', 'task_plans', 'tasks', 'thoughts'])
        await db.run(`DELETE FROM ${t}`, [], false);
    for (const t of b.tasks)
        await db.run('INSERT INTO tasks(id,title,deadline,estimated_minutes,importance,tags_json,is_long_term,created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?)', [t.id, t.title, t.deadline || null, t.estimated_minutes, t.importance, JSON.stringify(t.tags || []), t.is_long_term ? 1 : 0, t.created_at || now(), t.updated_at || now(), t.completed_at || null], false);
    for (const p of b.plans)
        await db.run('INSERT INTO task_plans(id,task_id,plan_date,start_time,completed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', [p.id, p.task_id, p.plan_date, p.start_time || null, p.completed_at || null, p.created_at || now(), p.updated_at || now()], false);
    for (const t of b.thoughts)
        await db.run('INSERT INTO thoughts(id,content,created_at,updated_at) VALUES(?,?,?,?)', [t.id, t.content, t.created_at || now(), t.updated_at || now()], false);
    for (const [k, v] of Object.entries(b.routine))
        if (k in DEFAULT_ROUTINE)
            await db.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [k, v], false);
    for (const p of b.fitnessPlans)
        await db.run('INSERT INTO fitness_plans(id,name,notes,created_at,updated_at,archived) VALUES(?,?,?,?,?,?)', [p.id, p.name, p.notes || '', p.created_at || now(), p.updated_at || now(), p.archived ? 1 : 0], false);
    for (const e of b.fitnessExercises)
        await db.run('INSERT INTO fitness_exercises(id,plan_id,sort_order,name,muscle_group,notes,recommended_sets,recommended_reps_min,recommended_reps_max,recommended_weight,recommended_rir,rest_seconds,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [e.id, e.plan_id, e.sort_order || 0, e.name, e.muscle_group || '', e.notes || '', e.recommended_sets, e.recommended_reps_min, e.recommended_reps_max, e.recommended_weight || 0, e.recommended_rir ?? null, e.rest_seconds ?? 90, e.created_at || now(), e.updated_at || now()], false);
    for (const w of b.warmups)
        await db.run('INSERT INTO warmups(id,sort_order,name,type,target_value,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', [w.id, w.sort_order || 0, w.name, w.type, w.target_value, w.notes || '', w.created_at || now(), w.updated_at || now()], false);
    for (const s of b.workoutSessions)
        await db.run('INSERT INTO workout_sessions(id,plan_id,plan_name,started_at,ended_at,status,current_exercise,current_set,rest_end_at,rest_paused_seconds,archived,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', [s.id, s.plan_id || null, s.plan_name, s.started_at, s.ended_at || null, s.status, s.current_exercise || 0, s.current_set || 1, s.rest_end_at || null, s.rest_paused_seconds ?? null, s.archived ? 1 : 0, s.created_at || now(), s.updated_at || now()], false);
    for (const x of b.workoutExercises)
        await db.run('INSERT INTO workout_exercises(id,session_id,sort_order,name,muscle_group,notes,recommended_sets,recommended_reps_min,recommended_reps_max,recommended_weight,recommended_rir,rest_seconds) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', [x.id, x.session_id, x.sort_order || 0, x.name, x.muscle_group || '', x.notes || '', x.recommended_sets, x.recommended_reps_min, x.recommended_reps_max, x.recommended_weight || 0, x.recommended_rir ?? null, x.rest_seconds ?? 90], false);
    for (const x of b.workoutSets)
        await db.run('INSERT INTO workout_sets(id,workout_exercise_id,set_number,actual_reps,actual_weight,actual_rir,completed_at) VALUES(?,?,?,?,?,?,?)', [x.id, x.workout_exercise_id, x.set_number, x.actual_reps, x.actual_weight || 0, x.actual_rir ?? null, x.completed_at || now()], false);
    await recoverCompletedWorkouts();
    await db.commitTransaction();
}
catch (e) {
    await db.rollbackTransaction();
    throw e;
} }
async function _replaceNotifications(r) { await db.beginTransaction(); try {
    await db.run('DELETE FROM notification_registry', [], false);
    for (const x of r)
        await db.run('INSERT INTO notification_registry(notification_id,task_id,plan_id,kind,scheduled_at) VALUES(?,?,?,?,?)', [x.notification_id, x.task_id, x.plan_id || null, x.kind, x.scheduled_at], false);
    await db.commitTransaction();
}
catch (e) {
    await db.rollbackTransaction();
    throw e;
} }
async function _saveFitnessPlan(i) { requireText(i.name, '计划名称'); for (const e of i.exercises || [])
    validateExercise(e); const t = now(), id = i.id || uuid(); await db.beginTransaction(); try {
    await db.run('INSERT INTO fitness_plans(id,name,notes,created_at,updated_at,archived) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,notes=excluded.notes,updated_at=excluded.updated_at,archived=excluded.archived', [id, i.name.trim(), i.notes || '', i.created_at || t, t, i.archived ? 1 : 0], false);
    await db.run('DELETE FROM fitness_exercises WHERE plan_id=?', [id], false);
    for (const [eidx, e] of (i.exercises || []).entries())
        await db.run('INSERT INTO fitness_exercises(id,plan_id,sort_order,name,muscle_group,notes,recommended_sets,recommended_reps_min,recommended_reps_max,recommended_weight,recommended_rir,rest_seconds,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [uuid(), id, eidx, e.name.trim(), e.muscle_group || '', e.notes || '', Number(e.recommended_sets), Number(e.recommended_reps_min), Number(e.recommended_reps_max), Number(e.recommended_weight || 0), e.recommended_rir === '' || e.recommended_rir == null ? null : Number(e.recommended_rir), Number(e.rest_seconds ?? 90), e.created_at || t, t], false);
    await db.commitTransaction();
    return id;
}
catch (e) {
    await db.rollbackTransaction();
    throw e;
} }
async function _duplicateFitnessPlan(id) { const p = (await rows('SELECT * FROM fitness_plans WHERE id=?', [id]))[0]; if (!p)
    throw new Error('训练计划不存在。'); const ex = await rows('SELECT * FROM fitness_exercises WHERE plan_id=? ORDER BY sort_order', [id]); return _saveFitnessPlan({ name: `${p.name} 副本`, notes: p.notes, exercises: ex.map(({ id, plan_id, ...e }) => e) }); }
async function _archiveFitnessPlan(id) { await db.run('UPDATE fitness_plans SET archived=1,updated_at=? WHERE id=?', [now(), id]); }
async function _restoreFitnessPlan(id) { await db.run('UPDATE fitness_plans SET archived=0,updated_at=? WHERE id=?', [now(), id]); }
async function _deleteFitnessPlan(id) { await db.beginTransaction(); try {
    const archived = (await rows('SELECT id FROM fitness_plans WHERE id=? AND archived=1', [id])).length;
    if (!archived)
        throw new Error('只能删除已归档计划。');
    await db.run('UPDATE workout_sessions SET plan_id=NULL WHERE plan_id=?', [id], false);
    await db.run('DELETE FROM fitness_exercises WHERE plan_id=?', [id], false);
    await db.run('DELETE FROM fitness_plans WHERE id=?', [id], false);
    await db.commitTransaction();
}
catch (e) {
    await db.rollbackTransaction();
    throw e;
} }
async function _archiveWorkout(id) { const result = await db.run("UPDATE workout_sessions SET archived=1,updated_at=? WHERE id=? AND status!='in_progress' AND archived=0", [now(), id]); if (!result.changes?.changes)
    throw new Error('只能归档未归档的已结束训练。'); }
async function _restoreWorkout(id) { const result = await db.run('UPDATE workout_sessions SET archived=0,updated_at=? WHERE id=? AND archived=1', [now(), id]); if (!result.changes?.changes)
    throw new Error('训练记录未归档或不存在。'); }
async function _deleteWorkout(id) { await db.beginTransaction(); try {
    const archived = (await rows("SELECT id FROM workout_sessions WHERE id=? AND status!='in_progress' AND archived=1", [id])).length;
    if (!archived)
        throw new Error('只能删除已归档的训练。');
    await db.run('DELETE FROM workout_sets WHERE workout_exercise_id IN (SELECT id FROM workout_exercises WHERE session_id=?)', [id], false);
    await db.run('DELETE FROM workout_exercises WHERE session_id=?', [id], false);
    await db.run('DELETE FROM workout_sessions WHERE id=?', [id], false);
    await db.commitTransaction();
}
catch (e) {
    await db.rollbackTransaction();
    throw e;
} }
async function _saveWarmup(i) {
    requireText(i.name, '热身名称');
    requireNumber(i.target_value, 1, 100000, '热身目标数值', true);
    if (!['reps', 'seconds'].includes(i.type))
        throw new Error('热身类型无效。');
    const existing = i.id ? (await rows('SELECT * FROM warmups WHERE id=?', [i.id]))[0] : null;
    const order = existing?.sort_order ?? Number((await rows('SELECT COALESCE(MAX(sort_order),-1)+1 AS next_order FROM warmups'))[0].next_order);
    const t = now(), id = i.id || uuid();
    await db.run('INSERT INTO warmups(id,sort_order,name,type,target_value,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,type=excluded.type,target_value=excluded.target_value,notes=excluded.notes,updated_at=excluded.updated_at', [id, order, i.name.trim(), i.type, Number(i.target_value), i.notes || '', existing?.created_at || t, t]);
    return id;
}
async function _deleteWarmup(id) { await db.run('DELETE FROM warmups WHERE id=?', [id]); }
async function _startWorkout(planId) { const p = (await rows('SELECT * FROM fitness_plans WHERE id=? AND archived=0', [planId]))[0]; if (!p)
    throw new Error('训练计划不存在或已归档。'); const ex = await rows('SELECT * FROM fitness_exercises WHERE plan_id=? ORDER BY sort_order', [planId]); if (!ex.length)
    throw new Error('请先为计划添加动作。'); const t = now(), sid = uuid(); if ((await rows("SELECT id FROM workout_sessions WHERE status='in_progress' LIMIT 1")).length)
    throw new Error('请先完成或结束当前训练。'); await db.beginTransaction(); try {
    await db.run('INSERT INTO workout_sessions(id,plan_id,plan_name,started_at,status,current_exercise,current_set,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', [sid, planId, p.name, t, 'in_progress', 0, 1, t, t], false);
    for (const [eidx, e] of ex.entries())
        await db.run('INSERT INTO workout_exercises(id,session_id,sort_order,name,muscle_group,notes,recommended_sets,recommended_reps_min,recommended_reps_max,recommended_weight,recommended_rir,rest_seconds) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', [uuid(), sid, eidx, e.name, e.muscle_group, e.notes, e.recommended_sets, e.recommended_reps_min, e.recommended_reps_max, e.recommended_weight, e.recommended_rir, e.rest_seconds], false);
    await db.commitTransaction();
    return sid;
}
catch (e) {
    await db.rollbackTransaction();
    throw e;
} }
async function validateWorkoutProgress(id, patch) {
    if ('status' in patch || 'ended_at' in patch) throw new Error('请使用结束训练操作修改训练状态。');
    const session = (await rows('SELECT * FROM workout_sessions WHERE id=?', [id]))[0];
    if (!session || session.status !== 'in_progress' || Number(session.archived) === 1)
        throw new Error('本次训练已经结束，不能继续更新训练状态。');
    const exercises = await rows('SELECT recommended_sets FROM workout_exercises WHERE session_id=? ORDER BY sort_order', [id]);
    const index = requireNumber(patch.current_exercise ?? session.current_exercise, 0, exercises.length - 1, '当前动作序号', true);
    requireNumber(patch.current_set ?? session.current_set, 1, exercises[index].recommended_sets, '当前训练组序号', true);
    const next = { ...session, ...patch };
    if (next.rest_end_at != null && (typeof next.rest_end_at !== 'string' || !Number.isFinite(Date.parse(next.rest_end_at))))
        throw new Error('休息结束时间无效。');
    if (next.rest_paused_seconds != null) requireNumber(next.rest_paused_seconds, 0, 3600, '暂停休息秒数', true);
    if (next.rest_end_at != null && next.rest_paused_seconds != null)
        throw new Error('休息不能同时处于计时和暂停状态。');
}
async function _updateWorkoutSession(id, patch) {
    await validateWorkoutProgress(id, patch);
    const keys = Object.keys(patch).filter(key => ['current_exercise', 'current_set', 'rest_end_at', 'rest_paused_seconds'].includes(key));
    if (!keys.length) return;
    await db.run(`UPDATE workout_sessions SET ${keys.map(key => `${key}=?`).join(',')},updated_at=? WHERE id=? AND status='in_progress' AND archived=0`, [...keys.map(key => patch[key] ?? null), now(), id]);
}
async function _saveWorkoutSet(i) {
    const exercise = (await rows('SELECT we.*,ws.status,ws.archived FROM workout_exercises we JOIN workout_sessions ws ON ws.id=we.session_id WHERE we.id=?', [i.workout_exercise_id]))[0];
    if (!exercise || exercise.status !== 'in_progress' || Number(exercise.archived) === 1)
        throw new Error('本次训练已经结束，不能继续记录训练组。');
    validateSet(i, exercise.recommended_sets);
    const recorded = await rows('SELECT set_number FROM workout_sets WHERE workout_exercise_id=? ORDER BY set_number', [i.workout_exercise_id]);
    if (!recorded.some(row => Number(row.set_number) === Number(i.set_number)) && Number(i.set_number) !== recorded.length + 1)
        throw new Error('请按顺序保存训练组，不能跳过组序号。');
    await db.run('INSERT INTO workout_sets(id,workout_exercise_id,set_number,actual_reps,actual_weight,actual_rir,completed_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(workout_exercise_id,set_number) DO UPDATE SET actual_reps=excluded.actual_reps,actual_weight=excluded.actual_weight,actual_rir=excluded.actual_rir,completed_at=excluded.completed_at', [i.id || uuid(), i.workout_exercise_id, Number(i.set_number), Number(i.actual_reps), Number(i.actual_weight || 0), i.actual_rir === '' || i.actual_rir == null ? null : Number(i.actual_rir), now()], false);
}
async function _saveWorkoutSetAndAdvance(i, p = {}) {
    await db.beginTransaction();
    try {
        await _saveWorkoutSet(i);
        const exercise = (await rows('SELECT session_id FROM workout_exercises WHERE id=?', [i.workout_exercise_id]))[0];
        const remaining = await rows('SELECT we.id FROM workout_exercises we LEFT JOIN workout_sets ws ON ws.workout_exercise_id=we.id WHERE we.session_id=? GROUP BY we.id HAVING COUNT(ws.id)<we.recommended_sets', [exercise.session_id]);
        if (!remaining.length) {
            const t = now();
            await db.run("UPDATE workout_sessions SET status='completed',ended_at=?,rest_end_at=NULL,rest_paused_seconds=NULL,updated_at=? WHERE id=? AND status='in_progress' AND archived=0", [t, t, exercise.session_id], false);
        }
        else {
            await validateWorkoutProgress(exercise.session_id, p);
            const keys = Object.keys(p).filter(k => ['current_exercise', 'current_set', 'rest_end_at', 'rest_paused_seconds'].includes(k));
            if (keys.length)
                await db.run(`UPDATE workout_sessions SET ${keys.map(k => `${k}=?`).join(',')},updated_at=? WHERE id=? AND status='in_progress' AND archived=0`, [...keys.map(k => p[k] ?? null), now(), exercise.session_id], false);
        }
        await db.commitTransaction();
    }
    catch (error) {
        await db.rollbackTransaction();
        throw error;
    }
}
async function _finishWorkout(id, status = 'completed') { if (!['completed', 'incomplete'].includes(status))
    throw new Error('训练状态无效。'); const result = await db.run("UPDATE workout_sessions SET status=?,ended_at=?,rest_end_at=NULL,rest_paused_seconds=NULL,updated_at=? WHERE id=? AND status='in_progress' AND archived=0", [status, now(), now(), id]); if (result.changes?.changes)
    return true; if (!(await rows('SELECT id FROM workout_sessions WHERE id=?', [id])).length)
    throw new Error('训练会话不存在。'); return false; }
async function _moveWarmup(id, direction) { const all = await rows('SELECT * FROM warmups ORDER BY sort_order,id'), i = all.findIndex(x => x.id === id), j = i + direction; if (i < 0 || j < 0 || j >= all.length)
    return; const temp = all[i]; all[i] = all[j]; all[j] = temp; await db.beginTransaction(); try {
    for (const [k, w] of all.entries())
        await db.run('UPDATE warmups SET sort_order=? WHERE id=?', [-k - 1, w.id], false);
    for (const [k, w] of all.entries())
        await db.run('UPDATE warmups SET sort_order=? WHERE id=?', [k, w.id], false);
    await db.commitTransaction();
}
catch (e) {
    await db.rollbackTransaction();
    throw e;
} }
// Keep internal calls inside their owning queued operation; exported calls
// wait for previous work even if it failed. This also gives backups a coherent snapshot.
let operationTail = Promise.resolve();
function enqueue(operation) { const result = operationTail.then(operation); operationTail = result.catch(() => { }); return result; }
export const initializeDatabase = (...args) => enqueue(() => _initializeDatabase(...args));
export const getSetting = (...args) => enqueue(() => _getSetting(...args));
export const setSetting = (...args) => enqueue(() => _setSetting(...args));
export const deleteSetting = (...args) => enqueue(() => _deleteSetting(...args));
export const saveRoutine = (...args) => enqueue(() => _saveRoutine(...args));
export const listState = (...args) => enqueue(() => _listState(...args));
export const saveTask = (...args) => enqueue(() => _saveTask(...args));
export const deleteTask = (...args) => enqueue(() => _deleteTask(...args));
export const removePlan = (...args) => enqueue(() => _removePlan(...args));
export const setTaskCompleted = (...args) => enqueue(() => _setTaskCompleted(...args));
export const setPlanCompleted = (...args) => enqueue(() => _setPlanCompleted(...args));
export const saveThought = (...args) => enqueue(() => _saveThought(...args));
export const deleteThought = (...args) => enqueue(() => _deleteThought(...args));
export const exportData = (...args) => enqueue(() => _exportData(...args));
export const importData = (...args) => enqueue(() => _importData(...args));
export const replaceNotifications = (...args) => enqueue(() => _replaceNotifications(...args));
export const saveFitnessPlan = (...args) => enqueue(() => _saveFitnessPlan(...args));
export const duplicateFitnessPlan = (...args) => enqueue(() => _duplicateFitnessPlan(...args));
export const archiveFitnessPlan = (...args) => enqueue(() => _archiveFitnessPlan(...args));
export const restoreFitnessPlan = (...args) => enqueue(() => _restoreFitnessPlan(...args));
export const deleteFitnessPlan = (...args) => enqueue(() => _deleteFitnessPlan(...args));
export const archiveWorkout = (...args) => enqueue(() => _archiveWorkout(...args));
export const restoreWorkout = (...args) => enqueue(() => _restoreWorkout(...args));
export const deleteWorkout = (...args) => enqueue(() => _deleteWorkout(...args));
export const saveWarmup = (...args) => enqueue(() => _saveWarmup(...args));
export const deleteWarmup = (...args) => enqueue(() => _deleteWarmup(...args));
export const startWorkout = (...args) => enqueue(() => _startWorkout(...args));
export const updateWorkoutSession = (...args) => enqueue(() => _updateWorkoutSession(...args));
export const saveWorkoutSet = (...args) => enqueue(() => _saveWorkoutSet(...args));
export const saveWorkoutSetAndAdvance = (...args) => enqueue(() => _saveWorkoutSetAndAdvance(...args));
export const finishWorkout = (...args) => enqueue(() => _finishWorkout(...args));
export const moveWarmup = (...args) => enqueue(() => _moveWarmup(...args));
