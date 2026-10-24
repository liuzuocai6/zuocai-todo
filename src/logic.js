export const toMinutes = value => {
  if (value === '24:00') return 1440;
  const [hour, minute] = String(value).split(':').map(Number);
  return hour * 60 + minute;
};

export const formatMinutes = value => {
  const day = value >= 1440 ? '次日 ' : '';
  const normalized = ((value % 1440) + 1440) % 1440;
  return `${day}${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
};

export function overlapMinutes(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

export function routineIntervals(routine) {
  const sleepStart = toMinutes(routine.sleep_start);
  const wake = toMinutes(routine.wake_time);
  const sleep = sleepStart > wake
    ? [{ label:'睡觉', start:0, end:wake }, { label:'睡觉', start:sleepStart, end:1440 }]
    : [{ label:'睡觉', start:sleepStart, end:wake }];
  const intervals = [
    ...sleep,
    { label:'早餐', start:toMinutes(routine.breakfast_start), end:toMinutes(routine.breakfast_end) },
    { label:'午餐', start:toMinutes(routine.lunch_start), end:toMinutes(routine.lunch_end) },
    { label:'晚餐', start:toMinutes(routine.dinner_start), end:toMinutes(routine.dinner_end) }
  ];
  return intervals.filter(item => item.end > item.start);
}

export function findPlanConflicts(candidate, tasks, plans, routine) {
  if (!candidate.start_time) return [];
  const start = toMinutes(candidate.start_time);
  const end = start + Number(candidate.estimated_minutes);
  const conflicts = [];
  for (const interval of routineIntervals(routine)) {
    const overlap = overlapMinutes(start, end, interval.start, interval.end);
    if (overlap) conflicts.push({ date:candidate.plan_date, label:interval.label, start:interval.start, end:interval.end, overlap });
  }
  const taskById = new Map(tasks.map(task => [task.id, task]));
  for (const plan of plans) {
    if (plan.id === candidate.plan_id || plan.plan_date !== candidate.plan_date || !plan.start_time || plan.completed_at) continue;
    const task = taskById.get(plan.task_id);
    if (!task || task.completed_at) continue;
    const otherStart = toMinutes(plan.start_time);
    const otherEnd = otherStart + Number(task.estimated_minutes);
    const overlap = overlapMinutes(start, end, otherStart, otherEnd);
    if (overlap) conflicts.push({ date:candidate.plan_date, label:`任务“${task.title}”`, start:otherStart, end:otherEnd, overlap });
  }
  return conflicts;
}

export function classifyHome(tasks, plans, today, daysBetween) {
  const byTask = new Map();
  for (const plan of plans) {
    if (!byTask.has(plan.task_id)) byTask.set(plan.task_id, []);
    byTask.get(plan.task_id).push(plan);
  }
  const todayPlans = plans.filter(plan => plan.plan_date === today && !plan.completed_at);
  const todayIds = new Set(todayPlans.map(plan => plan.task_id));
  const upcoming = [];
  const unscheduled = [];
  for (const task of tasks) {
    if (task.completed_at || task.is_long_term || todayIds.has(task.id)) continue;
    const taskPlans = byTask.get(task.id) || [];
    if (taskPlans.some(plan=>plan.plan_date===today&&plan.completed_at)) continue;
    const days = daysBetween(task.deadline, today);
    const futurePlans = taskPlans.filter(plan => {
      const offset = daysBetween(plan.plan_date, today);
      return offset !== null && offset > 0 && !plan.completed_at;
    });
    const scheduleHint = futurePlans.length
      ? `已安排 ${futurePlans.map(plan => `${plan.plan_date}${plan.start_time ? ` ${plan.start_time}` : ' 待安排'}`).join('、')}`
      : null;
    if (days !== null && days <= 3) {
      upcoming.push(scheduleHint ? { ...task, schedule_hint:scheduleHint } : task);
      continue;
    }
    const activeFuture = taskPlans.some(plan => plan.plan_date >= today && !plan.completed_at);
    if (futurePlans.length) {
      upcoming.push({ ...task, schedule_hint:scheduleHint });
      continue;
    }
    const expired = taskPlans.some(plan => plan.plan_date < today && !plan.completed_at);
    if (!activeFuture || expired) unscheduled.push({ ...task, plan_expired:expired });
  }
  return { todayPlans, upcoming, unscheduled };
}

export function assignOverlapLanes(events) {
  const sorted = [...events].sort((a,b) => a.start - b.start || a.end - b.end);
  const active = [];
  const groups = [];
  let group = [];
  let groupEnd = -1;
  for (const event of sorted) {
    if (group.length && event.start >= groupEnd) {
      groups.push(group); group = []; groupEnd = -1;
    }
    group.push(event); groupEnd = Math.max(groupEnd, event.end);
  }
  if (group.length) groups.push(group);
  const result = [];
  for (const items of groups) {
    active.length = 0;
    let maxLane = 0;
    const placed = [];
    for (const event of items) {
      for (let lane=0; lane<active.length; lane += 1) if (active[lane] <= event.start) active[lane] = null;
      let lane = active.findIndex(value => value === null);
      if (lane < 0) lane = active.length;
      active[lane] = event.end; maxLane = Math.max(maxLane, lane + 1);
      placed.push({ ...event, lane });
    }
    result.push(...placed.map(event => ({ ...event, lanes:maxLane })));
  }
  return result;
}

// SVG coordinates: 0 = left, 50 = top, 100 = right.
export const gaugeAngle = score => -180 + Math.max(0, Math.min(100, score)) * 1.8;
