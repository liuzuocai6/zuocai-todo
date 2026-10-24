export function normalizeRestState(session) {
  const pausedSeconds = Number(session?.rest_paused_seconds);
  const restEndAt = session?.rest_end_at || null;
  return {
    restEndAt,
    pausedSeconds: Number.isFinite(pausedSeconds) && pausedSeconds > 0 ? Math.ceil(pausedSeconds) : null,
    endMs: restEndAt ? Date.parse(restEndAt) : NaN,
  };
}

export function restState(session, now = Date.now()) {
  const { restEndAt, pausedSeconds, endMs } = normalizeRestState(session);
  const paused = pausedSeconds !== null;
  const running = Number.isFinite(endMs) && endMs > now;
  return {
    restEndAt,
    pausedSeconds,
    endMs,
    paused,
    running,
    active: paused || running,
    remainingSeconds: running ? Math.max(0, Math.ceil((endMs - now) / 1000)) : 0,
  };
}
