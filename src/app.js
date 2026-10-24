import './styles.css';
import './workout-focus.css';
import './schedule-fixes.css';
import { App } from '@capacitor/app';
import { LocalNotifications } from '@capacitor/local-notifications';
import { SCHEMA_VERSION, initializeDatabase, listState, saveTask, deleteTask, removePlan, setTaskCompleted, setPlanCompleted, saveThought, deleteThought, setSetting, deleteSetting, saveRoutine, exportData, validateBackup, importData, replaceNotifications, getSetting, saveFitnessPlan, duplicateFitnessPlan, archiveFitnessPlan, restoreFitnessPlan, deleteFitnessPlan, archiveWorkout, restoreWorkout, deleteWorkout, saveWarmup, deleteWarmup, moveWarmup, startWorkout, updateWorkoutSession, saveWorkoutSetAndAdvance, finishWorkout } from './db.js';
import { pressureSummary, routineCapacity, remainingCapacity, daysBetween } from './pressure.js';
import { rescheduleNotifications, scheduleTestNotification, exportBackup, exportWorkoutStatsCsv, clearAllNotifications } from './native.js';
import { toMinutes, formatMinutes, routineIntervals, findPlanConflicts, classifyHome, assignOverlapLanes, gaugeAngle, overlapMinutes } from './logic.js';
import { workoutDuration } from './fitness-time.js';
import { restState } from './workout-rest.js';
import { validateRoutine } from './data-validation.js';
import { workoutStatsCsv } from './workout-export.js';
import { activeSessions, archivedSessions, activePlans, archivedPlans } from './fitness-archive.js';
const storedWarmupSessions = () => { try {
    return new Set(JSON.parse(localStorage.getItem('zuocai.workoutWarmupShown') || '[]'));
}
catch {
    return new Set();
} };
const persistWarmupSessions = shown => { try {
    localStorage.setItem('zuocai.workoutWarmupShown', JSON.stringify([...shown]));
}
catch { } };
const storedWorkoutSession = () => { try {
    return localStorage.getItem('zuocai.activeWorkoutSession') || '';
}
catch {
    return '';
} };
const persistWorkoutSession = id => { try {
    if (id)
        localStorage.setItem('zuocai.activeWorkoutSession', id);
    else
        localStorage.removeItem('zuocai.activeWorkoutSession');
}
catch { } };
let warmupDone = new Set(), workoutWarmupShown = storedWarmupSessions(), selectedWorkoutExercise = new Map(), selectedFitnessPlanId = null, selectedStatsDay = null, recentWorkoutNotice = null, workoutWasOpenBeforeBackground = false, workoutViewHiddenByUser = false, workoutRestTimers = new Map(), workoutLifecycleBusy = false, workoutRecoveryInFlight = false;
const workoutSetDrafts = new Map();
const workoutDraftKey = (sessionId, exerciseId, setNumber) => `${sessionId}:${exerciseId}:${setNumber}`;
function captureWorkoutDraft() {
    const form = $('#set-form');
    if (!form?.dataset.exerciseId || form.dataset.saved) return;
    workoutSetDrafts.set(workoutDraftKey(form.dataset.sessionId, form.dataset.exerciseId, form.dataset.setNumber),
        Object.fromEntries(['reps', 'weight', 'rir'].map(key => [key, form.elements[key].value])));
}
function clearWorkoutDrafts(sessionId) {
    for (const key of workoutSetDrafts.keys()) if (key.startsWith(`${sessionId}:`)) workoutSetDrafts.delete(key);
    const form = $('#set-form');
    if (form?.dataset.sessionId === sessionId) form.dataset.saved = '1';
}
let state = { tasks: [], plans: [], thoughts: [], routine: {}, fitnessPlans: [], archivedFitnessPlans: [], warmups: [], workoutSessions: [], workoutExercises: [], workoutSets: [] }, pendingImport = null, pendingSave = null, statsMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1), refreshVersion = 0;
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const localIso = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10), todayIso = () => localIso(new Date());
const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + n); return localIso(d); };
const esc = v => String(v ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const importanceLabel = { low: '低', medium: '中', high: '高' }, taskById = id => state.tasks.find(t => t.id === id), plansFor = id => state.plans.filter(p => p.task_id === id);
function toast(m) { const e = $('#toast'); e.textContent = m; e.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => e.hidden = true, 3000); }
function bindFormSubmit(selector, handler) {
    const form = $(selector);
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (form.dataset.saving) return;
        form.dataset.saving = '1';
        try { await handler(event); }
        catch (error) { toast(error.message || '保存失败，请重试。'); }
        finally { form.removeAttribute('data-saving'); }
    });
}
const empty = m => `<p class="empty">${esc(m)}</p>`;
function taskMeta(t, p = null) { const a = [`${t.estimated_minutes} 分钟`, `${importanceLabel[t.importance]}重要性`]; if (t.deadline)
    a.push(`${t.deadline} 截止`); if (p)
    a.push(`${p.plan_date} ${p.start_time || '待安排'}`); if (t.plan_expired)
    a.push('原计划已过期'); if (t.schedule_hint)
    a.push(t.schedule_hint); if (t.tags?.length)
    a.push(t.tags.join(' · ')); return a.join(' · '); }
function taskCard(t, p = null, o = {}) { const done = Boolean(p ? (p.completed_at || t.completed_at) : t.completed_at), ind = Boolean(p && t.is_long_term), identity = ind ? p.id : t.id; const complete = o.complete === false ? '' : `<button class="complete-button" data-action="complete" data-target="${ind ? 'plan' : 'task'}" data-id="${esc(identity)}" aria-label="${done ? '恢复' : '完成'}">${done ? '✓' : ''}</button>`; const a = []; if (o.edit)
    a.push(`<button class="text-button" data-action="edit" data-id="${esc(t.id)}">编辑</button>`); if (o.schedule)
    a.push(`<button class="text-button" data-action="schedule" data-id="${esc(t.id)}">安排日程</button>`); if (p && o.removePlan)
    a.push(`<button class="text-button" data-action="remove-plan" data-id="${esc(p.id)}">移出日程</button>`); if (o.delete)
    a.push(`<button class="text-button" data-action="${p && t.is_long_term ? 'delete-plan' : 'delete-task'}" data-id="${esc(p && t.is_long_term ? p.id : t.id)}">删除</button>`); return `<article class="task-item ${done ? 'done ' : ''}${o.cardEdit ? 'card-editable' : ''}" ${o.cardEdit ? `data-card-edit="${esc(t.id)}"` : ''}><div class="task-main">${complete}<div class="task-copy"><strong>${esc(t.title)}</strong><p class="meta">${esc(taskMeta(t, p))}</p></div></div>${a.length ? `<div class="task-actions">${a.join('')}</div>` : ''}</article>`; }
function gaugeSvg(score) { const angle = gaugeAngle(score) * Math.PI / 180, x = 100 + 54 * Math.cos(angle), y = 88 + 54 * Math.sin(angle), segments = [['low', 'M20 88 A80 80 0 0 1 43.43 31.43'], ['medium', 'M43.43 31.43 A80 80 0 0 1 100 8'], ['high', 'M100 8 A80 80 0 0 1 156.57 31.43'], ['very-high', 'M156.57 31.43 A80 80 0 0 1 180 88']]; return `<svg class="gauge-svg" viewBox="0 0 200 105" aria-hidden="true">${segments.map(([name, path]) => `<path d="${path}" class="gauge-segment ${name}"/>`).join('')}<line x1="100" y1="88" x2="${x}" y2="${y}" class="gauge-needle"/><circle cx="100" cy="88" r="6" class="gauge-hub"/></svg>`; }
function renderToday() {
    const today = todayIso(), c = classifyHome(state.tasks, state.plans, today, daysBetween);
    const p = pressureSummary(state.tasks, state.plans, today, remainingCapacity(state.routine));
    const pendingIds = new Set(p.items.map(x => x.task.id));
    const todayItems = [...p.items].sort((a, b) => (a.plan?.start_time || '99:99').localeCompare(b.plan?.start_time || '99:99'));
    $('#today-count').textContent = todayItems.length;
    $('#today-list').innerHTML = todayItems.length ? todayItems.map(({ task, plan }) => taskCard(task, plan, { edit: true, removePlan: Boolean(plan), schedule: !plan, delete: true, cardEdit: true })).join('') : empty('今天没有待处理事项。');
    const upcoming = c.upcoming.filter(t => !pendingIds.has(t.id)).sort((a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999'));
    $('#upcoming-list').innerHTML = upcoming.length ? upcoming.map(t => taskCard(t, null, { edit: true, delete: true, cardEdit: true })).join('') : empty('近期没有逾期、到期或已安排事项。');
    $('#unscheduled-list').innerHTML = c.unscheduled.length ? c.unscheduled.map(t => taskCard(t, null, { edit: true, delete: true, cardEdit: true })).join('') : empty('没有未安排事项。');
    $('#pressure-level').textContent = p.level;
    $('#pressure-level').dataset.level = p.level;
    $('#pressure-gauge').innerHTML = `${gaugeSvg(p.score)}<div class="gauge-center"><strong>${p.score}</strong><span>/100</span></div>`;
    const plannedMinutes = p.plannedMinutes;
    $('#pressure-copy').textContent = `今日待处理 ${p.items.length} 项，预计 ${p.taskMinutes} 分钟。`;
    $('#pressure-capacity').textContent = `剩余可工作时间：${p.remainingMinutes} 分钟`;
    $('#pressure-free').textContent = `剩余可用任务时间：${Math.max(0, p.remainingMinutes - plannedMinutes)} 分钟${plannedMinutes > p.remainingMinutes ? `（已安排事项超出 ${plannedMinutes - p.remainingMinutes} 分钟）` : ''}`;
    $('#pressure-reason').textContent = p.overMinutes ? `任务时间超出剩余容量 ${p.overMinutes} 分钟。` : p.taskMinutes === 0 ? '今日没有待处理事项。' : `时间占用约 ${p.ratioPercent}%。`;
    if (p.items.length) {
        const hints = [];
        if (p.overdueCount)
            hints.push(`逾期 ${p.overdueCount} 项`);
        if (p.highCount)
            hints.push(`高重要性 ${p.highCount} 项`);
        if (hints.length)
            $('#pressure-reason').textContent += ` ${hints.join('、')}。`;
    }
}
function scheduleEvents(day) { const fixed = routineIntervals(state.routine).map((x, i) => ({ id: `fixed-${i}`, kind: x.label === '睡觉' ? 'sleep' : 'meal', title: x.label, start: x.start, end: x.end, detail: `${x.label} ${formatMinutes(x.start)}–${formatMinutes(x.end)}` })), pending = [], tasks = []; for (const p of state.plans.filter(x => x.plan_date === day)) {
    const t = taskById(p.task_id);
    if (!t)
        continue;
    if (!p.start_time) {
        if (!p.completed_at && !t.completed_at)
            pending.push({ task: t, plan: p });
        continue;
    }
    const start = toMinutes(p.start_time), actualEnd = start + Number(t.estimated_minutes), done = Boolean(p.completed_at || t.completed_at);
    tasks.push({ id: p.id, kind: 'task', title: t.title, start, end: Math.min(1440, actualEnd), done, detail: `${t.title}\n${day} ${p.start_time}–${formatMinutes(actualEnd)}\n预计 ${t.estimated_minutes} 分钟\n${done ? '已完成' : '未完成'}` });
} return { events: assignOverlapLanes([...fixed, ...tasks]), pending }; }
function eventBlock(e) { const top = e.start / 1440 * 100, height = Math.max((e.end - e.start) / 1440 * 100, .8), w = 82 / e.lanes, left = 16 + e.lane * w; return `<button class="time-block ${e.kind} ${e.done ? 'done' : ''}" data-detail="${esc(e.detail)}" style="top:${top}%;height:${height}%;left:${left}%;width:calc(${w}% - 4px)">${e.kind === 'task' ? `${formatMinutes(e.start)} ` : ''}${esc(e.title)}</button>`; }
function renderSchedule() { const start = addDays(todayIso(), -1), labels = ['昨天', '今天', '明天', '后天'], weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']; $('#schedule').innerHTML = Array.from({ length: 4 }, (_, i) => { const day = addDays(start, i), weekday = weekdays[new Date(`${day}T12:00:00`).getDay()], { events, pending } = scheduleEvents(day), m = ['00:00', state.routine.wake_time, state.routine.breakfast_start, state.routine.breakfast_end, state.routine.lunch_start, state.routine.lunch_end, state.routine.dinner_start, state.routine.dinner_end, state.routine.sleep_start, '24:00'], unique = [...new Set(m)].sort((a, b) => toMinutes(a) - toMinutes(b)); return `<div class="day-column" data-day-index="${i}"><div class="day-title"><strong>${labels[i]}</strong><p class="meta">${day.slice(5)} · ${weekday}</p></div><div class="timeline">${unique.map(v => `<span class="time-label ${v === '00:00' ? 'first' : ''} ${v === '24:00' ? 'last' : ''}" style="top:${toMinutes(v) / 1440 * 100}%">${v}</span>`).join('')}${events.map(eventBlock).join('')}</div>${pending.length ? `<div class="pending-box"><div class="pending-heading"><strong>待安排</strong><span>${pending.length} 项</span></div>${pending.map(({ task, plan }) => `<article class="pending-item" data-card-edit="${esc(task.id)}"><div><strong>${esc(task.title)}</strong><p>${esc(taskMeta(task, plan))}</p></div><div class="pending-actions"><button class="text-button" data-action="edit" data-id="${esc(task.id)}">编辑</button><button class="text-button" data-action="remove-plan" data-id="${esc(plan.id)}">移出日程</button></div></article>`).join('')}</div>` : ''}</div>`; }).join(''); }
function scrollScheduleToToday() { const t = $('#schedule [data-day-index="1"]'); if (t)
    $('#schedule').scrollTo({ left: t.offsetLeft - $('#schedule').offsetLeft, behavior: 'smooth' }); }
function renderGoals() { const g = state.tasks.filter(t => t.is_long_term && !t.completed_at); $('#goal-list').innerHTML = g.length ? g.map(t => { const ps = plansFor(t.id), done = ps.filter(p => p.completed_at).length, overview = ps.map(p => `${p.plan_date}${p.start_time ? ` ${p.start_time}` : ''}${p.completed_at ? ' ✓' : ''}`).join('、'); return taskCard({ ...t, tags: [...(t.tags || []), ...(overview ? [`安排：${overview}`] : []), ...(done ? [`已完成 ${done} 次`] : [])] }, null, { complete: false, edit: true, schedule: true, delete: true }); }).join('') : empty('还没有长期目标。'); const h = state.tasks.filter(t => t.completed_at && !t.is_long_term); $('#history-list').innerHTML = h.length ? h.map(t => taskCard(t, null, { complete: true, delete: true })).join('') : empty('还没有完成记录。'); }
function renderThoughts() { $('#thought-list').innerHTML = state.thoughts.length ? state.thoughts.map(x => `<article class="thought"><span>${esc(x.content)}</span><button class="text-button" data-action="delete-thought" data-id="${esc(x.id)}">删除</button></article>`).join('') : empty('还没有想法。'); }
function workoutHistoryCard(s, { compact = false } = {}) {
    const exercises = state.workoutExercises.filter(x => x.session_id === s.id).sort((a, b) => a.sort_order - b.sort_order);
    const sets = state.workoutSets.filter(q => exercises.some(x => x.id === q.workout_exercise_id));
    const completed = exercises.filter(x => state.workoutSets.filter(q => q.workout_exercise_id === x.id).length >= x.recommended_sets).length;
    const detail = compact ? '' : exercises.map(x => { const actual = sets.filter(q => q.workout_exercise_id === x.id).sort((a, b) => a.set_number - b.set_number); return `<div class="history-exercise"><strong>${esc(x.name)}${x.muscle_group ? ` <small>· ${esc(x.muscle_group)}</small>` : ''}</strong><p>推荐 ${x.recommended_sets}组 × ${x.recommended_reps_min}-${x.recommended_reps_max}次 · ${x.recommended_weight || 0}kg · RIR ${x.recommended_rir ?? '—'}</p>${actual.length ? actual.map(q => `<p>第${q.set_number}组：${q.actual_reps}次 × ${q.actual_weight || 0}kg · RIR ${q.actual_rir ?? '—'}</p>`).join('') : '<p>未完成</p>'}</div>`; }).join('');
    return `<article class="card history-workout"><div class="card-title"><strong>${esc(s.plan_name)} · ${s.status === 'completed' ? '已完成' : s.status === 'incomplete' ? '未完成' : '进行中'}</strong>${s.status === 'in_progress' ? '' : s.archived ? `<span class="workout-actions"><button class="text-button" data-fitness-action="restore-workout" data-id="${esc(s.id)}">恢复</button><button class="text-button" data-fitness-action="delete-workout" data-id="${esc(s.id)}">删除</button></span>` : `<button class="text-button" data-fitness-action="archive-workout" data-id="${esc(s.id)}">归档</button>`}</div><p class="muted">${new Date(s.started_at).toLocaleString('zh-CN')} · 用时 ${workoutDuration(s.started_at, s.ended_at ? Date.parse(s.ended_at) : Date.now())} · 动作 ${completed}/${exercises.length} · ${sets.length}组 · ${sets.reduce((n, q) => n + q.actual_reps, 0)}次 · 训练量 ${sets.reduce((n, q) => n + q.actual_reps * q.actual_weight, 0)}kg</p>${detail}</article>`;
}
function renderArchive() {
    $('#archived-plan-list').innerHTML = archivedPlans(state.archivedFitnessPlans).length ? archivedPlans(state.archivedFitnessPlans).map(p => `<article class="fitness-exercise"><strong>${esc(p.name)}</strong><span>${p.exercises.length} 个动作</span><div><button class="text-button" data-fitness-action="restore-plan" data-id="${esc(p.id)}">恢复</button><button class="text-button" data-fitness-action="delete-plan-permanent" data-id="${esc(p.id)}">删除</button></div></article>`).join('') : empty('没有已归档计划。');
    const history = archivedSessions(state.workoutSessions);
    $('#archived-workout-list').innerHTML = history.length ? history.map(s => workoutHistoryCard(s, { compact: true })).join('') : empty('没有训练记录。');
}
function renderFitness() {
    const current = state.workoutSessions.find(x => x.status === 'in_progress');
    const noticedSession = recentWorkoutNotice && state.workoutSessions.find(x => x.id === recentWorkoutNotice.id);
    if (!noticedSession || noticedSession.archived || noticedSession.status === 'in_progress')
        recentWorkoutNotice = null;
    const notice = noticedSession && !noticedSession.archived && noticedSession.status !== 'in_progress' ? workoutSummaryHtml(noticedSession) : '';
    $('#fitness-current').innerHTML = notice + (current ? `<div class="card-title"><strong>正在训练：${esc(current.plan_name)}</strong><button class="primary small" data-fitness-action="continue" data-id="${current.id}">继续训练</button></div><p class="muted">当前动作 ${Number(current.current_exercise) + 1}，第 ${current.current_set} 组 · 已用时 <span id="fitness-elapsed">${workoutDuration(current.started_at)}</span></p>` : '<strong>当前没有进行中的训练</strong><p class="muted">选择计划开始训练，中途离开会保留进度。</p>');
    if (!activePlans(state.fitnessPlans).some(p => p.id === selectedFitnessPlanId))
        selectedFitnessPlanId = activePlans(state.fitnessPlans)[0]?.id || null;
    const picker = $('#fitness-plan-picker'), pickerScroll = picker.scrollLeft;
    picker.innerHTML = activePlans(state.fitnessPlans).map(p => `<button class="${p.id === selectedFitnessPlanId ? 'selected' : ''}" data-fitness-action="show-plan" data-id="${esc(p.id)}">${esc(p.name)}</button>`).join('');
    picker.scrollLeft = pickerScroll;
    $('#fitness-plan-list').innerHTML = activePlans(state.fitnessPlans).length ? activePlans(state.fitnessPlans).filter(p => p.id === selectedFitnessPlanId).map(p => `<article class="fitness-plan-card"><div class="card-title"><div><h3>${esc(p.name)}</h3><p class="muted">${esc(p.notes || '')} · ${p.exercises.length} 个动作</p></div><button class="primary small" data-fitness-action="start" data-id="${p.id}">开始</button></div><div class="fitness-exercise-list">${p.exercises.map((e, i) => `<div class="fitness-exercise"><strong>${i + 1}. ${esc(e.name)}${e.muscle_group ? ` <small>· ${esc(e.muscle_group)}</small>` : ''}</strong><span>${e.recommended_sets}组 × ${e.recommended_reps_min}-${e.recommended_reps_max}次 · ${e.recommended_weight || 0}kg · RIR ${e.recommended_rir ?? '—'}</span></div>`).join('')}</div><div class="task-actions"><button class="text-button" data-fitness-action="edit-plan" data-id="${p.id}">编辑</button><button class="text-button" data-fitness-action="duplicate" data-id="${p.id}">复制</button><button class="text-button" data-fitness-action="archive" data-id="${p.id}">归档</button></div></article>`).join('') : empty('还没有训练计划。');
    $('#warmup-list').innerHTML = state.warmups.length ? state.warmups.map(w => `<article class="fitness-exercise"><strong>${esc(w.name)}</strong><span>${w.target_value}${w.type === 'reps' ? '次' : '秒'} ${esc(w.notes || '')}</span><div><button class="text-button" data-fitness-action="warmup-up" data-id="${w.id}">↑</button><button class="text-button" data-fitness-action="warmup-down" data-id="${w.id}">↓</button><button class="text-button" data-fitness-action="edit-warmup" data-id="${w.id}">编辑</button><button class="text-button" data-fitness-action="delete-warmup" data-id="${w.id}">删除</button></div></article>`).join('') : empty('还没有热身动作。');
    const key = `${statsMonth.getFullYear()}-${String(statsMonth.getMonth() + 1).padStart(2, '0')}`;
    $('#stats-month').textContent = statsMonth.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long' });
    const first = new Date(statsMonth.getFullYear(), statsMonth.getMonth(), 1), days = new Date(statsMonth.getFullYear(), statsMonth.getMonth() + 1, 0).getDate(), offset = (first.getDay() + 6) % 7, daySessions = activeSessions(state.workoutSessions).filter(s => localIso(new Date(s.started_at)).startsWith(key)), daysWith = new Set(daySessions.map(s => localIso(new Date(s.started_at))));
    let calendar = Array.from({ length: offset }, () => '<span></span>').join('');
    for (let i = 1; i <= days; i++) {
        const d = `${key}-${String(i).padStart(2, '0')}`;
        calendar += `<button class="calendar-day ${daysWith.has(d) ? 'has-workout' : ''}" data-fitness-action="day" data-date="${d}"><strong>${i}</strong>${daySessions.filter(s => localIso(new Date(s.started_at)) === d).map(s => `<small>${esc(s.plan_name)}</small>`).join('')}</button>`;
    }
    $('#fitness-calendar').innerHTML = calendar;
    if (selectedStatsDay?.startsWith(key))
        renderWorkoutDay(selectedStatsDay);
    else {
        selectedStatsDay = null;
        $('#fitness-day-detail').innerHTML = '';
    }
}
function workoutSummaryHtml(s) { const exercises = state.workoutExercises.filter(x => x.session_id === s.id); const sets = state.workoutSets.filter(q => exercises.some(x => x.id === q.workout_exercise_id)); const completed = exercises.filter(x => sets.filter(q => q.workout_exercise_id === x.id).length >= x.recommended_sets).length; const volume = sets.reduce((n, q) => n + Number(q.actual_reps) * Number(q.actual_weight), 0); return `<article class="card workout-summary"><div class="card-title"><strong>上次训练已保存：${esc(s.plan_name)}</strong><button class="text-button" data-fitness-action="summary-stats">查看训练统计</button></div><p class="muted">${s.status === 'completed' ? '已完成' : '已保存为未完成'} · ${new Date(s.started_at).toLocaleString('zh-CN')} · 用时 ${workoutDuration(s.started_at, s.ended_at ? Date.parse(s.ended_at) : Date.now())}</p><p class="muted">动作 ${completed}/${exercises.length} · ${sets.length} 组 · ${sets.reduce((n, q) => n + Number(q.actual_reps), 0)} 次 · 训练量 ${volume}kg</p></article>`; }
function renderWorkoutDay(day) { selectedStatsDay = day; const sessions = activeSessions(state.workoutSessions).filter(s => localIso(new Date(s.started_at)) === day); $('#fitness-day-detail').innerHTML = sessions.length ? sessions.map(s => workoutHistoryCard(s)).join('') : empty('当天没有训练记录。'); }
function openFitnessPlan(plan = null) { const f = $('#fitness-plan-form'); f.reset(); $('#fitness-plan-title').textContent = plan ? '编辑训练计划' : '新建训练计划'; f.elements.id.value = plan?.id || ''; f.elements.name.value = plan?.name || ''; f.elements.notes.value = plan?.notes || ''; $('#exercise-editor').innerHTML = (plan?.exercises || []).map((e, i) => exerciseRow(e, i)).join(''); $('#fitness-plan-dialog').showModal(); }
function exerciseRow(e = {}, i = 0) { return `<fieldset class="exercise-edit"><legend>动作 ${i + 1}<button type="button" class="text-button exercise-up">↑</button><button type="button" class="text-button exercise-down">↓</button><button type="button" class="text-button remove-exercise">删除</button></legend><div class="form-grid"><label>名称<input name="ename" value="${esc(e.name || '')}" required></label><label>肌群<input name="muscle_group" value="${esc(e.muscle_group || '')}"></label><label>组数<input name="recommended_sets" type="number" min="1" value="${e.recommended_sets || 3}"></label><label>次数最小<input name="recommended_reps_min" type="number" min="1" value="${e.recommended_reps_min || 8}"></label><label>次数最大<input name="recommended_reps_max" type="number" min="1" value="${e.recommended_reps_max || 12}"></label><label>重量kg<input name="recommended_weight" type="number" min="0" step="0.5" value="${e.recommended_weight || 0}"></label><label>RIR<input name="recommended_rir" type="number" min="0" max="10" step="0.5" value="${e.recommended_rir ?? ''}"></label><label>休息秒<input name="rest_seconds" type="number" min="0" value="${e.rest_seconds ?? 90}"></label></div><label>备注<textarea name="enotes">${esc(e.notes || '')}</textarea><input type="hidden" name="eid" value="${e.id || ''}"></fieldset>`; }
function openWarmup(w = null) { const f = $('#warmup-form'); f.reset(); f.elements.id.value = w?.id || ''; f.elements.name.value = w?.name || ''; f.elements.type.value = w?.type || 'reps'; f.elements.target_value.value = w?.target_value || 10; f.elements.notes.value = w?.notes || ''; $('#warmup-dialog').showModal(); }
function renderAll() { renderToday(); renderSchedule(); renderGoals(); renderThoughts(); renderSettings(); renderFitness(); renderArchive(); }
function updateWorkoutElapsed() { const current = state.workoutSessions.find(s => s.status === 'in_progress'); if (!current)
    return; for (const id of ['fitness-elapsed', 'workout-elapsed']) {
    const el = $(`#${id}`);
    if (el)
        el.textContent = workoutDuration(current.started_at);
} }
function renderSettings() { if (!$('#routine-form').dataset.dirty)
    for (const [k, v] of Object.entries(state.routine))
        $('#routine-form').elements[k].value = v; const c = routineCapacity(state.routine); $('#capacity-copy').textContent = `全天可工作 ${c.available} 分钟；睡眠 ${c.sleep} 分钟、三餐 ${c.meals} 分钟、周期休息 ${c.rest} 分钟。`; $('#database-version').textContent = SCHEMA_VERSION; }
let latestRefresh;
async function refresh() {
    const version = ++refreshVersion;
    const reading = listState().then(next => {
        if (version !== refreshVersion) return;
        state = next;
        renderAll();
    });
    latestRefresh = reading;
    let pending = reading;
    // Callers that reopen a dialog must also wait for a newer refresh, rather
    // than reopening from stale state after their own read was discarded.
    do {
        await pending;
        if (pending === latestRefresh) break;
        pending = latestRefresh;
    } while (pending);
    return true;
}
function clearWorkoutRestTimer(id) { const timer = workoutRestTimers.get(id); if (timer !== undefined) {
    clearInterval(timer);
    workoutRestTimers.delete(id);
} }
function retireWorkoutRestTimer(id, timer) { clearInterval(timer); if (workoutRestTimers.get(id) === timer)
    workoutRestTimers.delete(id); }
function clearAllWorkoutRestTimers() { for (const id of [...workoutRestTimers.keys()])
    clearWorkoutRestTimer(id); }
async function recoverWorkoutAfterStartup() {
    const id = storedWorkoutSession();
    const session = state.workoutSessions.find(x => x.id === id) || state.workoutSessions.find(x => x.status === 'in_progress');
    if (!session) {
        if (id)
            persistWorkoutSession('');
        recentWorkoutNotice = state.workoutSessions.find(x => x.status !== 'in_progress' && !x.archived) || null;
        renderFitness();
        return;
    }
    const sessionId = session.id;
    if (session.status === 'in_progress') {
        persistWorkoutSession(sessionId);
        if (!workoutViewHiddenByUser)
            openWorkout(sessionId);
        return;
    }
    recentWorkoutNotice = session;
    clearWorkoutRestTimer(sessionId);
    clearWorkoutDrafts(sessionId);
    workoutWarmupShown.delete(sessionId);
    persistWarmupSessions(workoutWarmupShown);
    selectedWorkoutExercise.delete(sessionId);
    persistWorkoutSession('');
    const dialog = $('#workout-dialog');
    if (dialog.open)
        dialog.close();
    dialog.dataset.sessionId = '';
    renderFitness();
}
function renderWorkoutWarmup(id) { const s = state.workoutSessions.find(x => x.id === id); $('#workout-content').innerHTML = `<h3>训练前热身</h3><p class="muted">已用时 <span id="workout-elapsed">${workoutDuration(s.started_at)}</span> · 完成情况仅在本次打开期间显示，不写入训练历史。</p>${state.warmups.map(w => `<div class="warmup-check ${warmupDone.has(w.id) ? 'done' : ''}"><span>${esc(w.name)} · ${w.target_value}${w.type === 'reps' ? '次' : '秒'}</span>${warmupDone.has(w.id) ? `<button class="text-button" data-fitness-action="redo-warmup" data-id="${esc(id)}" data-warmup-id="${esc(w.id)}">重做</button>` : `<button class="secondary" data-fitness-action="complete-warmup" data-id="${esc(id)}" data-warmup-id="${esc(w.id)}">完成</button>`}</div>`).join('')}<button class="primary wide" data-fitness-action="warmup-next" data-id="${esc(id)}">进入正式训练</button>`; }
function bindFitnessEnhancements() {
    const actions = new Set(['show-plan', 'restore-plan', 'delete-plan-permanent', 'archive-workout', 'restore-workout', 'delete-workout', 'complete-warmup', 'redo-warmup', 'warmup-next', 'day']);
    document.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-fitness-action]');
        if (!b || !actions.has(b.dataset.fitnessAction))
            return;
        e.stopPropagation();
        const { fitnessAction: action, id, warmupId } = b.dataset;
        try {
            if (action === 'show-plan') {
                selectedFitnessPlanId = id;
                renderFitness();
                $('#fitness-plan-picker .selected')?.scrollIntoView({ block: 'nearest', inline: 'center' });
            }
            else if (action === 'restore-plan') {
                await restoreFitnessPlan(id);
                selectedFitnessPlanId = id;
                await refresh();
            }
            else if (action === 'delete-plan-permanent' && confirm('永久删除这个已归档计划？训练历史会保留。')) {
                await deleteFitnessPlan(id);
                await refresh();
            }
            else if (action === 'archive-workout') {
                await archiveWorkout(id);
                await refresh();
            }
            else if (action === 'restore-workout') {
                await restoreWorkout(id);
                await refresh();
            }
            else if (action === 'delete-workout' && confirm('永久删除这次训练记录及所有组数？')) {
                await deleteWorkout(id);
                await refresh();
            }
            else if (action === 'complete-warmup' || action === 'redo-warmup') {
                if (action === 'complete-warmup')
                    warmupDone.add(warmupId);
                else
                    warmupDone.delete(warmupId);
                renderWorkoutWarmup(id);
            }
            else if (action === 'warmup-next') {
                const remaining = state.warmups.filter(w => !warmupDone.has(w.id)).length;
                if (remaining && !confirm(`还有 ${remaining} 个热身动作未完成，仍要进入正式训练吗？`))
                    return;
                workoutWarmupShown.add(id);
                persistWarmupSessions(workoutWarmupShown);
                openWorkout(id);
            }
            else if (action === 'day')
                renderWorkoutDay(b.dataset.date);
        }
        catch (error) {
            toast(error.message);
        }
    }, true);
}
function openWorkout(id) {
    captureWorkoutDraft();
    const s = state.workoutSessions.find(x => x.id === id);
    if (!s)
        return;
    clearWorkoutRestTimer(id);
    workoutViewHiddenByUser = false;
    $('#workout-dialog').dataset.sessionId = id;
    persistWorkoutSession(id);
    if (s.status !== 'in_progress') {
        clearWorkoutDrafts(id);
        recentWorkoutNotice = s;
        workoutWarmupShown.delete(id);
        persistWarmupSessions(workoutWarmupShown);
        selectedWorkoutExercise.delete(id);
        if ($('#workout-dialog').open)
            $('#workout-dialog').close();
        $('#workout-dialog').dataset.sessionId = '';
        persistWorkoutSession('');
        renderFitness();
        toast(s.status === 'completed' ? '本次训练已完成，已显示摘要' : '本次训练已保存为未完成，已显示摘要');
        return;
    }
    if (!workoutWarmupShown.has(id) && state.warmups.length && !state.workoutExercises.some(ex => ex.session_id === id && state.workoutSets.some(set => set.workout_exercise_id === ex.id))) {
        renderWorkoutWarmup(id);
        if (!$('#workout-dialog').open)
            $('#workout-dialog').showModal();
        return;
    }
    const ex = state.workoutExercises.filter(x => x.session_id === id).sort((a, b) => a.sort_order - b.sort_order), chosen = selectedWorkoutExercise.get(id), active = chosen ?? s.current_exercise, x = ex[active];
    if (!x)
        return;
    const sets = state.workoutSets.filter(q => q.workout_exercise_id === x.id), rest = restState(s), end = rest.endMs, paused = rest.paused, resting = rest.active, exerciseDone = sets.length >= x.recommended_sets, blocked = resting || exerciseDone;
    $('#workout-content').innerHTML = `<h3>${esc(s.plan_name)} · ${esc(x.name)}${x.muscle_group ? ` <small>· ${esc(x.muscle_group)}</small>` : ''}</h3><p class="muted">已用时 <span id="workout-elapsed">${workoutDuration(s.started_at)}</span></p><div class="workout-exercise-tabs">${ex.map((item, index) => { const done = state.workoutSets.filter(q => q.workout_exercise_id === item.id).length >= item.recommended_sets; return `<button class="${index === active ? 'selected' : ''} ${done ? 'completed' : ''}" data-fitness-action="select-exercise" data-id="${id}" data-index="${index}"><span>${esc(item.name)}</span>${item.muscle_group ? `<small>${esc(item.muscle_group)}</small>` : ''}</button>`; }).join('')}</div><div class="workout-recommendation"><p>${esc(x.notes || '无备注')}</p><p>推荐 ${x.recommended_sets}组 × ${x.recommended_reps_min}-${x.recommended_reps_max}次 · ${x.recommended_weight || 0}kg</p><p>RIR ${x.recommended_rir ?? '—'} · 休息 ${x.rest_seconds}秒</p></div><p>已完成 ${sets.length}/${x.recommended_sets} 组</p><div class="workout-set-list">${sets.map(q => `<p>第${q.set_number}组：${q.actual_reps}次 × ${q.actual_weight}kg · RIR ${q.actual_rir ?? '—'}</p>`).join('')}</div>${s.rest_end_at || paused ? `<div class="card"><strong id="rest-countdown">${paused ? '休息已暂停' : resting ? `休息剩余 ${Math.floor(rest.remainingSeconds / 60)}:${String(rest.remainingSeconds % 60).padStart(2, '0')}` : '休息已完成'}</strong><div class="button-row"><button class="secondary" data-fitness-action="skip-rest" data-id="${id}">跳过休息</button><button class="secondary" data-fitness-action="${paused ? 'resume-rest' : 'pause-rest'}" data-id="${id}">${paused ? '继续' : '暂停'}</button><button class="secondary" data-fitness-action="add-rest" data-id="${id}">＋30秒</button></div></div>` : ''}<form id="set-form"><div class="form-grid"><label>次数<input name="reps" type="number" min="1" required ${blocked ? 'disabled' : ''}></label><label>重量kg<input name="weight" type="number" min="0" step="0.5" value="${x.recommended_weight || 0}" ${blocked ? 'disabled' : ''}></label><label>RIR<input name="rir" type="number" min="0" max="10" step="0.5" value="${x.recommended_rir ?? ''}" ${blocked ? 'disabled' : ''}></label></div><button class="primary wide" ${blocked ? 'disabled' : ''}>${exerciseDone ? '此动作已完成' : `保存第 ${sets.length + 1} 组`}</button></form><button class="secondary wide" data-fitness-action="finish-incomplete" data-id="${id}">结束并保存为未完成</button>`;
    requestAnimationFrame(() => $('#workout-content .workout-exercise-tabs .selected')?.scrollIntoView({ block: 'nearest', inline: 'center' }));
    const form = $('#set-form');
    form.dataset.sessionId = id;
    form.dataset.exerciseId = x.id;
    form.dataset.setNumber = String(sets.length + 1);
    const draft = workoutSetDrafts.get(workoutDraftKey(id, x.id, sets.length + 1));
    if (draft) for (const [key, value] of Object.entries(draft)) form.elements[key].value = value;
    if (resting && !paused) {
        const timer = setInterval(() => { const dialog = $('#workout-dialog'); if (!dialog?.open || dialog.dataset.sessionId !== id || workoutRestTimers.get(id) !== timer) {
            retireWorkoutRestTimer(id, timer);
            return;
        } const countdown = $('#rest-countdown'); if (!countdown) {
            clearWorkoutRestTimer(id);
            return;
        } const left = Math.max(0, Math.ceil((end - Date.now()) / 1000)); countdown.textContent = left ? `休息剩余 ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : '休息已完成'; if (!left) {
            clearWorkoutRestTimer(id);
            const form = $('#set-form');
            for (const input of form.querySelectorAll('input,button'))
                input.disabled = exerciseDone;
        } }, 1000);
        workoutRestTimers.set(id, timer);
    }
    $('#set-form').onsubmit = async (e) => {
        e.preventDefault();
        if (workoutLifecycleBusy)
            return;
        workoutLifecycleBusy = true;
        const f = e.currentTarget;
        try {
            const currentState = state.workoutSessions.find(y => y.id === id);
            if (!currentState || currentState.status !== 'in_progress')
                throw new Error('本次训练已经结束，不能继续记录训练组。');
            if (restState(currentState).active)
                throw new Error('请等待休息结束，或先跳过休息。');
            const latestSets = state.workoutSets.filter(q => q.workout_exercise_id === x.id);
            if (latestSets.length >= x.recommended_sets)
                throw new Error('此动作已完成，请选择其他动作。');
            const count = item => state.workoutSets.filter(q => q.workout_exercise_id === item.id).length + (item.id === x.id ? 1 : 0);
            const allDone = ex.every(item => count(item) >= item.recommended_sets);
            const nextIndex = count(x) < x.recommended_sets ? active : ex.findIndex((item, index) => index > active && count(item) < item.recommended_sets);
            const next = nextIndex >= 0 ? nextIndex : ex.findIndex(item => count(item) < item.recommended_sets);
            const nextSet = next >= 0 ? count(ex[next]) + 1 : 1;
            await saveWorkoutSetAndAdvance({ workout_exercise_id: x.id, set_number: latestSets.length + 1, actual_reps: f.elements.reps.value, actual_weight: f.elements.weight.value, actual_rir: f.elements.rir.value }, allDone ? {} : { current_exercise: next, current_set: nextSet, rest_end_at: Number(x.rest_seconds) > 0 ? new Date(Date.now() + Number(x.rest_seconds) * 1000).toISOString() : null, rest_paused_seconds: null });
            workoutSetDrafts.delete(workoutDraftKey(id, x.id, latestSets.length + 1));
            f.dataset.saved = '1';
            selectedWorkoutExercise.delete(id);
            await refresh();
            const session = state.workoutSessions.find(q => q.id === id);
            if (session?.status === 'completed') {
                clearWorkoutDrafts(id);
                clearWorkoutRestTimer(id);
                workoutWarmupShown.delete(id);
                persistWarmupSessions(workoutWarmupShown);
                persistWorkoutSession('');
                $('#workout-dialog').close();
                $('#workout-dialog').dataset.sessionId = '';
                recentWorkoutNotice = session;
                renderFitness();
                toast('训练已完成');
            }
            else if (!workoutViewHiddenByUser)
                openWorkout(id);
        }
        catch (error) {
            await refresh();
            const session = state.workoutSessions.find(q => q.id === id);
            if (!session || session.status !== 'in_progress')
                await recoverWorkoutAfterStartup();
            toast(error.message);
        }
        finally {
            workoutLifecycleBusy = false;
        }
    };
    if (!$('#workout-dialog').open)
        $('#workout-dialog').showModal();
}
async function askFinishWorkout(id) {
    if (workoutLifecycleBusy) {
        toast('正在保存训练记录，请稍后再结束。');
        return false;
    }
    const session = state.workoutSessions.find(x => x.id === id);
    if (!session || session.status !== 'in_progress') {
        await refresh();
        await recoverWorkoutAfterStartup();
        return false;
    }
    if (!confirm('确定结束这次训练并保存为未完成吗？已记录的组数会保留。')) return false;
    workoutLifecycleBusy = true;
    try {
        const changed = await finishWorkout(id, 'incomplete');
        clearWorkoutDrafts(id);
        clearWorkoutRestTimer(id);
        workoutWarmupShown.delete(id);
        persistWarmupSessions(workoutWarmupShown);
        selectedWorkoutExercise.delete(id);
        persistWorkoutSession('');
        $('#workout-dialog').close();
        $('#workout-dialog').dataset.sessionId = '';
        await refresh();
        recentWorkoutNotice = state.workoutSessions.find(x => x.id === id) || null;
        renderFitness();
        return changed;
    } finally {
        workoutLifecycleBusy = false;
    }
}
function bindFitness() { document.addEventListener('click', async (e) => { const b = e.target.closest('[data-fitness-action]'); if (!b)
    return; const a = b.dataset.fitnessAction, id = b.dataset.id; try {
    if (a === 'new-plan')
        openFitnessPlan();
    else if (a === 'edit-plan')
        openFitnessPlan(state.fitnessPlans.find(x => x.id === id));
    else if (a === 'duplicate') {
        selectedFitnessPlanId = await duplicateFitnessPlan(id);
        await refresh();
    }
    else if (a === 'archive' && confirm('归档此计划？训练历史会保留。')) {
        await archiveFitnessPlan(id);
        await refresh();
    }
    else if (a === 'add-exercise')
        $('#exercise-editor').insertAdjacentHTML('beforeend', exerciseRow({}, $$('#exercise-editor .exercise-edit').length));
    else if (a === 'new-warmup')
        openWarmup();
    else if (a === 'edit-warmup')
        openWarmup(state.warmups.find(x => x.id === id));
    else if (a === 'warmup-up' || a === 'warmup-down') {
        await moveWarmup(id, a === 'warmup-up' ? -1 : 1);
        await refresh();
    }
    else if (a === 'delete-warmup' && confirm('删除这个热身动作？')) {
        await deleteWarmup(id);
        await refresh();
    }
    else if (a === 'start') {
        if (workoutLifecycleBusy)
            return;
        workoutLifecycleBusy = true;
        try {
            const sid = await startWorkout(id);
            warmupDone.clear();
            recentWorkoutNotice = null;
            await refresh();
            openWorkout(sid);
        }
        finally {
            workoutLifecycleBusy = false;
        }
    }
    else if (a === 'continue') {
        await refresh();
        openWorkout(id);
    }
    else if (a === 'summary-stats') {
        const date = new Date(recentWorkoutNotice.started_at);
        statsMonth = new Date(date.getFullYear(), date.getMonth(), 1);
        selectedStatsDay = localIso(date);
        renderFitness();
        document.querySelector('[data-fitness-tab="stats"]')?.click();
    }
    else if (a === 'select-exercise') {
        selectedWorkoutExercise.set(id, Number(b.dataset.index));
        openWorkout(id);
    }
    else if (['skip-rest', 'pause-rest', 'resume-rest', 'add-rest'].includes(a)) {
        await changeWorkoutRest(id, a);
    }
    else if (a === 'finish-incomplete') {
        await askFinishWorkout(id);
    }
    else if (a === 'prev-month' || a === 'next-month') {
        statsMonth.setMonth(statsMonth.getMonth() + (a === 'prev-month' ? -1 : 1));
        renderFitness();
    }
}
catch (x) {
    toast(x.message);
} }); document.addEventListener('click', e => { const b = e.target.closest('[data-fitness-tab]'); if (!b)
    return; $$('[data-fitness-tab]').forEach(x => x.classList.toggle('active', x === b)); for (const tab of ['plans', 'warmups', 'stats'])
    $(`#fitness-${tab}-panel`).hidden = tab !== b.dataset.fitnessTab; }); document.addEventListener('click', e => { if (e.target.matches('.remove-exercise'))
    e.target.closest('.exercise-edit').remove(); if (e.target.matches('.exercise-up')) {
    const row = e.target.closest('.exercise-edit');
    if (row.previousElementSibling)
        row.previousElementSibling.before(row);
} if (e.target.matches('.exercise-down')) {
    const row = e.target.closest('.exercise-edit');
    if (row.nextElementSibling)
        row.nextElementSibling.after(row);
} }); bindFormSubmit('#fitness-plan-form', async (e) => { e.preventDefault(); const f = e.currentTarget, ex = [...f.querySelectorAll('.exercise-edit')].map(x => { const g = n => x.querySelector(`[name="${n}"]`)?.value || ''; return { id: g('eid') || null, name: g('ename'), muscle_group: g('muscle_group'), notes: g('enotes'), recommended_sets: Number(g('recommended_sets')), recommended_reps_min: Number(g('recommended_reps_min')), recommended_reps_max: Number(g('recommended_reps_max')), recommended_weight: Number(g('recommended_weight') || 0), recommended_rir: g('recommended_rir'), rest_seconds: g('rest_seconds') === '' ? 0 : Number(g('rest_seconds')) }; }); if (ex.some(x => !x.name || !Number.isInteger(x.recommended_sets) || x.recommended_sets < 1 || x.recommended_sets > 100 || !Number.isInteger(x.recommended_reps_min) || x.recommended_reps_min < 1 || !Number.isInteger(x.recommended_reps_max) || x.recommended_reps_max < x.recommended_reps_min || x.recommended_weight < 0 || x.recommended_rir !== '' && (Number(x.recommended_rir) < 0 || Number(x.recommended_rir) > 10) || x.rest_seconds < 0 || x.rest_seconds > 3600)) {
    toast('请检查动作名称和推荐次数范围');
    return;
} selectedFitnessPlanId = await saveFitnessPlan({ id: f.elements.id.value || null, name: f.elements.name.value, notes: f.elements.notes.value, exercises: ex }); $('#fitness-plan-dialog').close(); await refresh(); }); bindFormSubmit('#warmup-form', async (e) => { e.preventDefault(); const f = e.currentTarget; await saveWarmup({ id: f.elements.id.value || null, name: f.elements.name.value, type: f.elements.type.value, target_value: f.elements.target_value.value, notes: f.elements.notes.value, sort_order: state.warmups.length }); $('#warmup-dialog').close(); await refresh(); }); }
let notificationSyncTail = Promise.resolve();
function syncNotifications(request = false) {
    const result = notificationSyncTail.then(() => syncNotificationsNow(request));
    notificationSyncTail = result.catch(() => { });
    return result;
}
async function syncNotificationsNow(request = false) {
    try {
        const permission = request ? await LocalNotifications.requestPermissions() : await LocalNotifications.checkPermissions();
        if (permission.display !== 'granted') {
            $('#notification-status').textContent = '通知权限未启用；请在系统设置中允许本 App 发送通知。';
            return false;
        }
        let exact = await LocalNotifications.checkExactNotificationSetting();
        if (request && exact.exact_alarm !== 'granted')
            exact = await LocalNotifications.changeExactNotificationSetting();
        const latest = await listState();
        const result = await rescheduleNotifications(latest.tasks, latest.plans);
        await replaceNotifications(result.records);
        const complete = result.records.length === result.expectedCount;
        const timing = exact.exact_alarm === 'granted' ? '精确提醒已允许。' : '精确提醒未允许，Android 可能延迟通知；请在系统设置中允许“闹钟和提醒”。';
        $('#notification-status').textContent = `已核对 ${result.records.length}/${result.expectedCount} 条未来提醒。${timing}`;
        return complete;
    }
    catch (e) {
        $('#notification-status').textContent = `提醒同步失败，但任务数据未受影响：${e.message}`;
        return false;
    }
}
async function refreshThenNotify(message) { await refresh(); toast(message); if (!await syncNotifications(false))
    toast(`${message}，但提醒未同步`); }
function availableDates() { const t = todayIso(); return Array.from({ length: 3 }, (_, i) => addDays(t, i)); }
function renderDateChoices(selected = [], multi = false, starts = {}) {
    const dates = [...new Set([...availableDates(), ...selected])].sort();
    $('#task-plan-dates').dataset.multi = multi ? 'true' : 'false';
    $('#task-plan-dates').dataset.starts = JSON.stringify(starts);
    $('#task-plan-dates').innerHTML = dates.map(d => {
        const offset = daysBetween(d, todayIso()), label = ['今天', '明天', '后天'][offset] || '已安排';
        return `<div class="date-plan-row"><button type="button" class="date-choice ${selected.includes(d) ? 'selected' : ''}" data-date="${d}">${label}<br><small>${d.slice(5)}</small></button><label>开始时间<input class="date-start-time" data-date="${d}" type="time" value="${esc(starts[d] || '')}" ${selected.includes(d) ? '' : 'disabled'}></label></div>`;
    }).join('');
}
function openTaskDialog(t = null, force = false) { const f = $('#task-form'); f.reset(); f.elements.id.value = t?.id || ''; f.elements.title.value = t?.title || ''; f.elements.estimated_minutes.value = t?.estimated_minutes || 30; f.elements.importance.value = t?.importance || 'medium'; f.elements.deadline.value = t?.deadline || ''; f.elements.tags.value = (t?.tags || []).join('，'); f.elements.is_long_term.checked = force || Boolean(t?.is_long_term); const ps = t ? plansFor(t.id) : [], starts = Object.fromEntries(ps.map(p => [p.plan_date, p.start_time || ''])); renderDateChoices(ps.map(p => p.plan_date), f.elements.is_long_term.checked, starts); $('#task-dialog-title').textContent = t ? '编辑事项' : force ? '新建长期目标' : '新建事项'; $('#task-error').textContent = ''; $('#task-dialog').showModal(); }
function taskPayload(f) { const id = f.elements.id.value || null, existing = id ? taskById(id) : null, selected = $$('#task-plan-dates .selected').map(b => b.dataset.date), old = existing ? plansFor(existing.id) : [], plans = selected.map(d => { const p = old.find(x => x.plan_date === d), input = $(`.date-start-time[data-date="${d}"]`); return { ...p, plan_date: d, start_time: input?.value || null, completed_at: p?.completed_at || null }; }); return { input: { id, created_at: existing?.created_at, completed_at: existing?.completed_at, title: f.elements.title.value, estimated_minutes: Number(f.elements.estimated_minutes.value), importance: f.elements.importance.value, deadline: f.elements.deadline.value || null, tags: f.elements.tags.value.split(/[，,]/).map(v => v.trim()).filter(Boolean), is_long_term: f.elements.is_long_term.checked, plans }, old }; }
const payloadConflicts = p => p.input.plans.flatMap(plan => findPlanConflicts({ plan_id: plan.id, plan_date: plan.plan_date, start_time: plan.start_time, estimated_minutes: p.input.estimated_minutes }, state.tasks, state.plans, state.routine));
const conflictHtml = c => c.map(x => `<p><strong>${esc(x.date)}</strong>：与${esc(x.label)} ${esc(formatMinutes(x.start))}–${esc(formatMinutes(x.end))} 重叠 ${x.overlap} 分钟</p>`).join('');
async function persistTask(p) { await saveTask(p.input); $('#task-dialog').close(); await refreshThenNotify('已保存'); }
async function saveTaskForm(e) { e.preventDefault(); const p = taskPayload(e.currentTarget); if (!p.input.is_long_term && p.input.plans.length > 1) {
    $('#task-error').textContent = '普通事项只能安排一个日期。';
    return;
} const c = payloadConflicts(p); if (c.length) {
    pendingSave = () => persistTask(p);
    $('#conflict-list').innerHTML = conflictHtml(c);
    $('#conflict-dialog').showModal();
    return;
} await persistTask(p); }
function routineConflicts(r) { const out = [], map = new Map(state.tasks.map(t => [t.id, t])), last = addDays(todayIso(), 3); for (const p of state.plans) {
    const t = map.get(p.task_id);
    if (!t || t.completed_at || p.completed_at || !p.start_time || p.plan_date < todayIso() || p.plan_date > last)
        continue;
    const s = toMinutes(p.start_time), e = s + t.estimated_minutes;
    for (const fixed of routineIntervals(r)) {
        const overlap = overlapMinutes(s, e, fixed.start, fixed.end);
        if (overlap)
            out.push({ date: p.plan_date, label: `${fixed.label}与任务“${t.title}”`, start: fixed.start, end: fixed.end, overlap });
    }
} return out; }
async function persistRoutine(r) { await saveRoutine(r); $('#routine-form').removeAttribute('data-dirty'); await refreshThenNotify('作息已保存'); }
async function handleAction(b) { const { action, id } = b.dataset; if (action === 'new-task')
    return openTaskDialog(); if (action === 'new-goal')
    return openTaskDialog(null, true); if (action === 'edit' || action === 'schedule')
    return openTaskDialog(taskById(id)); if (action === 'complete') {
    if (b.dataset.target === 'plan') {
        const p = state.plans.find(x => x.id === id);
        await setPlanCompleted(id, !p.completed_at);
    }
    else {
        const t = taskById(id);
        await setTaskCompleted(id, !t.completed_at);
    }
    return refreshThenNotify('状态已更新');
} if (action === 'remove-plan') {
    await removePlan(id);
    return refreshThenNotify('已移出日程');
} if (action === 'delete-plan' && confirm('确定删除这个长期目标当天的安排吗？')) {
    await removePlan(id);
    return refreshThenNotify('已删除当天安排');
} if (action === 'delete-task' && confirm('确定永久删除这个事项及其日程吗？')) {
    await deleteTask(id);
    return refreshThenNotify('已删除');
} if (action === 'delete-thought' && confirm('确定删除这条想法吗？')) {
    await deleteThought(id);
    await refresh();
} }
async function recoverWorkoutOnLifecycleResume() {
    if (workoutRecoveryInFlight)
        return;
    workoutRecoveryInFlight = true;
    const restoreView = workoutWasOpenBeforeBackground && !workoutViewHiddenByUser;
    try {
        await refresh();
        if (restoreView && !workoutViewHiddenByUser)
            await recoverWorkoutAfterStartup();
    }
    catch (error) {
        toast(`训练状态恢复失败：${error.message}`);
    }
    finally {
        workoutRecoveryInFlight = false;
        workoutWasOpenBeforeBackground = false;
    }
}
function bindEvents() { $('#routine-form').addEventListener('input', () => { $('#routine-form').dataset.dirty = '1'; }); bindFitness(); $$('.bottom-nav button').forEach(b => b.addEventListener('click', () => { $$('.bottom-nav button').forEach(i => i.classList.toggle('active', i === b)); $$('.page').forEach(p => p.classList.toggle('active', p.dataset.page === b.dataset.tab)); if (b.dataset.tab === 'schedule')
    requestAnimationFrame(scrollScheduleToToday);
else
    window.scrollTo({ top: 0, behavior: 'smooth' }); })); document.addEventListener('click', e => { const b = e.target.closest('[data-action]'); if (b)
    handleAction(b).catch(x => toast(x.message)); }); document.addEventListener('click', e => { const c = e.target.closest('[data-card-edit]'); if (c && !e.target.closest('button'))
    openTaskDialog(taskById(c.dataset.cardEdit)); }); document.addEventListener('click', e => { const b = e.target.closest('.time-block[data-detail]'); if (b) {
    $('#schedule-detail').innerHTML = b.dataset.detail.split('\n').map(x => `<p>${esc(x)}</p>`).join('');
    $('#schedule-detail-dialog').showModal();
} }); $$('[data-close]').forEach(b => b.addEventListener('click', () => $(`#${b.dataset.close}`).close())); bindFormSubmit('#task-form', saveTaskForm); $('#task-form').elements.is_long_term.addEventListener('change', e => { const selected = $$('#task-plan-dates .selected').map(b => b.dataset.date), starts = Object.fromEntries($$('.date-start-time').map(i => [i.dataset.date, i.value])); renderDateChoices(selected, e.target.checked, starts); }); $('#force-save').addEventListener('click', async () => { const action = pendingSave; pendingSave = null; if (!action)
    return; $('#conflict-dialog').close(); try {
    await action();
} catch (error) {
    pendingSave = action;
    $('#conflict-dialog').showModal();
    toast(error.message || '保存失败，请重试。');
} }); bindFormSubmit('#thought-form', async (e) => { e.preventDefault(); const i = $('#thought-content'); if (!i.value.trim())
    return; await saveThought(i.value); i.value = ''; await refresh(); }); bindFormSubmit('#routine-form', async (e) => { e.preventDefault(); const r = Object.fromEntries(Object.keys(state.routine).map(k => [k, e.currentTarget.elements[k].value])); try {
    validateRoutine(r);
}
catch (error) {
    toast(error.message);
    return;
} const c = routineConflicts(r); if (c.length) {
    pendingSave = () => persistRoutine(r);
    $('#conflict-list').innerHTML = conflictHtml(c);
    $('#conflict-dialog').showModal();
    return;
} await persistRoutine(r); }); $('#enable-notifications').addEventListener('click', async () => { const ok = await syncNotifications(true); toast(ok ? '未来提醒已核对，请查看精确权限状态' : '请查看提醒状态并完成系统设置'); }); $('#test-notification').addEventListener('click', async () => { try {
    const at = await scheduleTestNotification();
    toast(`测试提醒已排程：${at.toLocaleTimeString('zh-CN')}，请锁屏等待并查看通知栏。`);
}
catch (e) {
    toast(`测试提醒失败：${e.message}`);
} }); $('#export-backup').addEventListener('click', async () => { try {
    const data = validateBackup(await exportData()), name = await exportBackup(data), at = new Date().toISOString();
    await setSetting('last_export_at', at);
    toast(`已生成 ${name}`);
}
catch (error) {
    toast(`备份导出失败：${error.message}`);
} }); $('#export-workout-stats').addEventListener('click', async () => { try {
    const csv = workoutStatsCsv(state.workoutSessions, state.workoutExercises, state.workoutSets);
    const name = await exportWorkoutStatsCsv(csv);
    toast(`已生成 ${name}`);
}
catch (error) {
    toast(`导出失败：${error.message}`);
} }); $('#import-backup').addEventListener('click', () => $('#backup-file').click()); $('#backup-file').addEventListener('change', async (e) => { try {
    const f = e.target.files[0];
    if (!f)
        return;
    pendingImport = validateBackup(JSON.parse(await f.text()));
    $('#import-summary').textContent = `备份包含 ${pendingImport.tasks.length} 个事项、${pendingImport.plans.length} 条日程、${pendingImport.thoughts.length} 条想法、${pendingImport.fitnessPlans.length} 个训练计划和 ${pendingImport.workoutSessions.length} 次训练。`;
    $('#import-dialog').showModal();
}
catch (x) {
    toast(x.message);
}
finally {
    e.target.value = '';
} }); $('#confirm-import').addEventListener('click', async () => { if (!pendingImport)
    return; try {
    const backup = pendingImport;
    pendingImport = null;
    await importData(backup);
    clearAllWorkoutRestTimers();
    workoutSetDrafts.clear();
    if ($('#set-form')) $('#set-form').dataset.saved = '1';
    selectedWorkoutExercise.clear();
    workoutWarmupShown.clear();
    persistWarmupSessions(workoutWarmupShown);
    persistWorkoutSession('');
    recentWorkoutNotice = null;
    workoutViewHiddenByUser = true;
    $('#workout-dialog').close();
    $('#workout-dialog').dataset.sessionId = '';
    $('#routine-form').removeAttribute('data-dirty');
    $('#import-dialog').close();
    await refreshThenNotify('备份已恢复');
}
catch (x) {
    toast(`导入失败：${x.message}`);
} }); const onInactive = () => { const dialog = $('#workout-dialog'); workoutWasOpenBeforeBackground = Boolean(dialog?.open) && !workoutViewHiddenByUser; }; const onActive = () => { recoverWorkoutOnLifecycleResume().then(() => syncNotifications(false)).catch(error => toast(error.message)); }; App.addListener('appStateChange', ({ isActive }) => isActive ? onActive() : onInactive()); App.addListener('pause', onInactive); App.addListener('resume', onActive); document.addEventListener('visibilitychange', () => document.hidden ? onInactive() : onActive()); setInterval(() => refresh().catch(() => { }), 60000); }
async function start() { try {
    await initializeDatabase();
    bindFitnessEnhancements();
    bindWorkoutCloseGuard();
    bindDateToggle();
    bindEvents();
    await refresh();
    await recoverWorkoutAfterStartup();
    setInterval(updateWorkoutElapsed, 10000);
    $('#app').hidden = false;
    if (await getSetting('clear_legacy_notifications') === '1') {
        try {
            await clearAllNotifications();
            await deleteSetting('clear_legacy_notifications');
        }
        catch { }
    }
    await syncNotifications(false);
}
catch (e) {
    $('#fatal h1').textContent = 'App 启动失败';
    $('#fatal-message').textContent = e?.message || String(e);
    $('#fatal').hidden = false;
} }
function closeWorkoutView() { captureWorkoutDraft(); const dialog = $('#workout-dialog'), id = dialog.dataset.sessionId; if (id)
    clearWorkoutRestTimer(id); workoutViewHiddenByUser = true; if (dialog.open)
    dialog.close(); if (id)
    persistWorkoutSession(id); renderFitness(); }
function bindWorkoutCloseGuard() { const dialog = $('#workout-dialog'); document.addEventListener('click', e => { const close = e.target.closest('[data-close="workout-dialog"]'); if (!close)
    return; e.preventDefault(); e.stopImmediatePropagation(); closeWorkoutView(); }, true); dialog.addEventListener('cancel', e => { e.preventDefault(); closeWorkoutView(); }); App.addListener('backButton', async () => { if (dialog.open) {
    closeWorkoutView();
    return;
} const top = [...document.querySelectorAll('dialog[open]')].at(-1); if (top) {
    top.close();
    return;
} await App.minimizeApp(); }); }
function bindDateToggle() { const box = $('#task-plan-dates'); box.addEventListener('click', e => { const button = e.target.closest('.date-choice'); if (!button)
    return; e.preventDefault(); e.stopPropagation(); const date = button.dataset.date, selected = button.classList.contains('selected'), multi = box.dataset.multi === 'true'; const starts = JSON.parse(box.dataset.starts || '{}'); if (selected) {
    starts[date] = $(`.date-start-time[data-date="${date}"]`)?.value || starts[date] || '';
    button.classList.remove('selected');
    const input = $(`.date-start-time[data-date="${date}"]`);
    if (input)
        input.disabled = true;
}
else {
    if (!multi)
        $$('#task-plan-dates .date-choice').forEach(other => { other.classList.remove('selected'); const input = $(`.date-start-time[data-date="${other.dataset.date}"]`); if (input)
            input.disabled = true; });
    button.classList.add('selected');
    const input = $(`.date-start-time[data-date="${date}"]`);
    if (input) {
        input.disabled = false;
        input.value = starts[date] || input.value || '';
    }
} box.dataset.starts = JSON.stringify(starts); }, true); }
start();
async function changeWorkoutRest(id, action) {
    if (workoutLifecycleBusy)
        return;
    workoutLifecycleBusy = true;
    try {
        const latest = await listState(), session = latest.workoutSessions.find(x => x.id === id);
        if (!session || session.status !== 'in_progress')
            throw new Error('本次训练已经结束。');
        const rest = restState(session);
        let patch;
        if (action === 'skip-rest')
            patch = { rest_end_at: null, rest_paused_seconds: null };
        else if (action === 'pause-rest') {
            if (!rest.running)
                return;
            patch = { rest_end_at: null, rest_paused_seconds: rest.remainingSeconds };
        }
        else if (action === 'resume-rest') {
            if (!rest.paused)
                return;
            patch = { rest_end_at: new Date(Date.now() + rest.pausedSeconds * 1000).toISOString(), rest_paused_seconds: null };
        }
        else {
            const seconds = Math.min(3600, (rest.paused ? rest.pausedSeconds : rest.remainingSeconds) + 30);
            patch = rest.paused ? { rest_end_at: null, rest_paused_seconds: seconds } : { rest_end_at: new Date(Date.now() + seconds * 1000).toISOString(), rest_paused_seconds: null };
        }
        await updateWorkoutSession(id, patch);
        await refresh();
        if (!workoutViewHiddenByUser)
            openWorkout(id);
    }
    catch (error) {
        toast(error.message);
    }
    finally {
        workoutLifecycleBusy = false;
    }
}
