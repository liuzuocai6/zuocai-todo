export const activePlans = plans => plans.filter(plan => Number(plan.archived) === 0);
export const archivedPlans = plans => plans.filter(plan => Number(plan.archived) === 1);
export const activeSessions = sessions => sessions.filter(session => Number(session.archived) === 0);
export const archivedSessions = sessions => sessions.filter(session => session.status !== 'in_progress' && Number(session.archived) === 1);
