function notificationId(text) {
  let hash = 0;
  for (const char of text) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return Math.abs(hash) % 2147483000 + 1;
}

function dateAt(iso, time) { return new Date(`${iso}T${time}:00`); }

export function buildNotificationRecords(tasks, plans, now = new Date()) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const result = [];
  for (const plan of plans) {
    const task = byId.get(plan.task_id);
    if (!task || task.completed_at || plan.completed_at) continue;
    if (plan.start_time) {
      const start = dateAt(plan.plan_date, plan.start_time);
      const at = new Date(start.getTime() - 10 * 60000);
      // Once the ten-minute reminder time has passed, do not recreate the
      // same alarm when the app returns to the foreground or resyncs a task.
      if (at > now) result.push({ notification_id:notificationId(`start:${plan.id}`), task_id:task.id, plan_id:plan.id, kind:'start', scheduled_at:at.toISOString(), title:'任务即将开始', body:`${task.title} · ${plan.start_time}` });
    }
  }
  for (const task of tasks) {
    if (!task.deadline || task.completed_at) continue;
    const at = dateAt(task.deadline, '09:00');
    if (at > now) result.push({ notification_id:notificationId(`due:${task.id}:${task.deadline}`), task_id:task.id, plan_id:null, kind:'due', scheduled_at:at.toISOString(), title:'事项今天到期', body:task.title });
  }
  return result;
}
