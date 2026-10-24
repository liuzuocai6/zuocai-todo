const clock = /^([01]\d|2[0-3]):[0-5]\d$/;
export const validDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === value;
};
export function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空。`);
}
export function requireNumber(value, min, max, label, integer=false) {
  const n = Number(value);
  if (value == null || typeof value === 'boolean' || typeof value === 'string' && !value.trim() || !Number.isFinite(n) || n < min || n > max || integer && !Number.isInteger(n)) throw new Error(`${label}须在 ${min}–${max} 之间${integer?'，且为整数':''}。`);
  return n;
}
export function validateRoutine(routine) {
  for (const key of ['sleep_start','wake_time','breakfast_start','breakfast_end','lunch_start','lunch_end','dinner_start','dinner_end']) {
    if (!clock.test(routine[key] || '')) throw new Error('请填写有效的作息时间。');
  }
  if (routine.sleep_start === routine.wake_time) throw new Error('睡觉和起床时间不能相同。');
  for (const meal of ['breakfast','lunch','dinner']) {
    if (routine[`${meal}_start`] >= routine[`${meal}_end`]) throw new Error('三餐结束时间须晚于开始时间。');
  }
  requireNumber(routine.rest_minutes_per_hour ?? 10,0,59,'每小时休息分钟数',true);
}
export function validateTask(task) {
  requireText(task.title,'事项标题');
  requireNumber(task.estimated_minutes,1,1440,'预计分钟数',true);
  if (!['low','medium','high'].includes(task.importance)) throw new Error('重要性无效。');
  if (task.deadline && !validDate(task.deadline)) throw new Error('截止日期无效。');
  const dates = new Set();
  for (const plan of task.plans || []) {
    if (!validDate(plan.plan_date) || plan.start_time && !clock.test(plan.start_time) || dates.has(plan.plan_date)) throw new Error('事项安排日期或开始时间无效。');
    dates.add(plan.plan_date);
  }
  if (!task.is_long_term && dates.size > 1) throw new Error('普通事项只能安排一个日期。');
}
export function validateExercise(exercise) {
  requireText(exercise.name,'动作名称');
  requireNumber(exercise.recommended_sets,1,100,'推荐组数',true);
  const min = requireNumber(exercise.recommended_reps_min,1,1000,'推荐最少次数',true);
  const max = requireNumber(exercise.recommended_reps_max,1,1000,'推荐最多次数',true);
  if (min > max) throw new Error('推荐最少次数不能大于最多次数。');
  requireNumber(exercise.recommended_weight ?? 0,0,10000,'推荐重量');
  if (exercise.recommended_rir != null && exercise.recommended_rir !== '') requireNumber(exercise.recommended_rir,0,10,'推荐 RIR');
  requireNumber(exercise.rest_seconds ?? 90,0,3600,'推荐休息秒数',true);
}
export function validateSet(set, recommendedSets) {
  requireNumber(set.set_number,1,recommendedSets,'训练组序号',true);
  requireNumber(set.actual_reps,1,1000,'实际次数',true);
  requireNumber(set.actual_weight ?? 0,0,10000,'实际重量');
  if (set.actual_rir != null && set.actual_rir !== '') requireNumber(set.actual_rir,0,10,'实际 RIR');
}
