const columns = ['训练日期','开始时间','结束时间','用时分钟','状态','计划名称','动作顺序','动作名称','肌群','推荐组数','推荐次数最小','推荐次数最大','推荐重量kg','推荐RIR','推荐休息秒数','实际组序号','实际次数','实际重量kg','实际RIR','组完成时间','该组训练量kg'];
const localDate = value => {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
};
const csvCell = value => {
  const string = String(value ?? '');
  return /[",\r\n]/.test(string) ? `"${string.replaceAll('"','""')}"` : string;
};

export function workoutStatsRows(sessions, exercises, sets) {
  const rows = [];
  for (const session of sessions.filter(item => item.status !== 'in_progress' && !Boolean(item.archived))) {
    const duration = session.ended_at ? Math.max(0, Math.floor((Date.parse(session.ended_at)-Date.parse(session.started_at))/60000)) : '';
    const common = [localDate(session.started_at),session.started_at,session.ended_at ?? '',duration,session.status,session.plan_name];
    const sessionExercises = exercises.filter(item => item.session_id === session.id).sort((a,b)=>a.sort_order-b.sort_order);
    if (!sessionExercises.length) rows.push([...common,...Array(columns.length-common.length).fill('')]);
    for (const exercise of sessionExercises) {
      const exerciseInfo = [exercise.sort_order+1,exercise.name,exercise.muscle_group,exercise.recommended_sets,exercise.recommended_reps_min,exercise.recommended_reps_max,exercise.recommended_weight,exercise.recommended_rir,exercise.rest_seconds];
      const actualSets = sets.filter(item => item.workout_exercise_id === exercise.id).sort((a,b)=>a.set_number-b.set_number);
      if (!actualSets.length) rows.push([...common,...exerciseInfo,...Array(6).fill('')]);
      for (const set of actualSets) rows.push([...common,...exerciseInfo,set.set_number,set.actual_reps,set.actual_weight,set.actual_rir,set.completed_at,Number(set.actual_reps)*Number(set.actual_weight)]);
    }
  }
  return rows;
}

export function workoutStatsCsv(sessions, exercises, sets) {
  return [columns,...workoutStatsRows(sessions,exercises,sets)].map(row=>row.map(csvCell).join(',')).join('\r\n');
}
