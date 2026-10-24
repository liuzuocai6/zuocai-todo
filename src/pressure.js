import { routineIntervals } from './logic.js';

const DAY_MINUTES = 1440;
const minutesInDay = date => date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;

export function daysBetween(iso, today) {
  if (!iso) return null;
  const a = new Date(`${iso}T12:00:00`);
  const b = new Date(`${today}T12:00:00`);
  return Math.round((a - b) / 86400000);
}

// Build the complete local day before calculating the remaining capacity.
export function workingIntervals(routine) {
  const rest = Number(routine.rest_minutes_per_hour ?? 10);
  if (!Number.isInteger(rest) || rest < 0 || rest > 59) throw new Error('每小时休息分钟数须在 0–59 之间。');
  const excluded = routineIntervals(routine)
    .map(({ start, end }) => ({ start:Math.max(0,start), end:Math.min(DAY_MINUTES,end) }))
    .filter(x => x.end > x.start).sort((a,b) => a.start - b.start);
  const merged = [];
  for (const block of excluded) {
    const last = merged.at(-1);
    if (last && block.start <= last.end) last.end = Math.max(last.end,block.end);
    else merged.push({ ...block });
  }
  const free = [];
  let cursor = 0;
  for (const block of merged) {
    if (cursor < block.start) free.push({ start:cursor, end:block.start });
    cursor = Math.max(cursor,block.end);
  }
  if (cursor < DAY_MINUTES) free.push({ start:cursor, end:DAY_MINUTES });
  const work = [], breaks = [], workLength = 60 - rest;
  for (const block of free) {
    let position = block.start;
    while (position < block.end) {
      const workEnd = Math.min(position + workLength,block.end);
      work.push({ start:position, end:workEnd });
      position = workEnd;
      if (position < block.end && rest) {
        const breakEnd = Math.min(position + rest,block.end);
        breaks.push({ start:position, end:breakEnd });
        position = breakEnd;
      }
    }
  }
  return { work, breaks, excluded:merged };
}

export function routineCapacity(routine) {
  const periods = workingIntervals(routine);
  const sum = rows => rows.reduce((n,x) => n + x.end - x.start,0);
  const sleep = routineIntervals(routine).filter(x => x.label === '睡觉');
  const sleepMinutes = sum(sleep);
  const excludedMinutes = sum(periods.excluded);
  return { sleep:sleepMinutes, meals:excludedMinutes-sleepMinutes, rest:sum(periods.breaks), available:sum(periods.work) };
}

export function remainingCapacity(routine, now = new Date()) {
  const current = minutesInDay(now);
  return Math.ceil(workingIntervals(routine).work.reduce((n,x) => n + Math.max(0,x.end - Math.max(x.start,current)),0));
}

export function todayPendingItems(tasks, plans, today) {
  const todayPlans = new Map(plans.filter(p => p.plan_date === today).map(p => [p.task_id,p]));
  const futurePlanned = new Set(plans.filter(p => p.plan_date > today && !p.completed_at).map(p => p.task_id));
  const relevant = [];
  for (const task of tasks) {
    if (task.completed_at) continue;
    const plan = todayPlans.get(task.id);
    if (plan?.completed_at) continue;
    const days = daysBetween(task.deadline,today);
    const source = plan ? 'planned' : days !== null && days < 0 ? 'overdue' : days === 0 && !futurePlanned.has(task.id) ? 'due' : null;
    if (source) relevant.push({ task, plan:plan || null, source });
  }
  return relevant;
}

export function pressureSummary(tasks, plans, today, capacity) {
  const items = todayPendingItems(tasks,plans,today);
  const taskMinutes = items.reduce((n,{task}) => n + Number(task.estimated_minutes),0);
  const plannedMinutes = items.filter(({plan}) => Boolean(plan)).reduce((n,{task}) => n + Number(task.estimated_minutes),0);
  const remainingMinutes = Math.max(0,capacity);
  const ratioPercent = remainingMinutes ? Math.round(taskMinutes / remainingMinutes * 100) : taskMinutes ? Infinity : 0;
  const score = Math.min(100,ratioPercent);
  const level = score <= 24 ? '低' : score <= 49 ? '中' : score <= 74 ? '高' : '很高';
  return { items, score, level, taskMinutes, plannedMinutes, remainingMinutes,
    overMinutes:Math.max(0,taskMinutes - remainingMinutes), ratioPercent,
    highCount:items.filter(x => x.task.importance === 'high').length,
    urgentCount:items.filter(x => x.task.deadline && x.task.deadline <= today).length,
    overdueCount:items.filter(x => x.source === 'overdue').length };
}
