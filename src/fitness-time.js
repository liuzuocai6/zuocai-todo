export function workoutDuration(startedAt, endedAt = Date.now()) {
  const elapsed = Math.max(0, Math.floor((Number(endedAt) - Date.parse(startedAt)) / 60000));
  return `${Math.floor(elapsed / 60)}小时${String(elapsed % 60).padStart(2,'0')}分钟`;
}
