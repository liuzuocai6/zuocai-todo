import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppHarness } from './helpers/app-harness.js';

async function ongoing({ db, storage }) {
  const planId = await db.saveFitnessPlan({ name: '推日', exercises: [{ name: '卧推', recommended_sets: 3, recommended_reps_min: 8, recommended_reps_max: 12, recommended_weight: 50, recommended_rir: 2, rest_seconds: 90 }] });
  const sessionId = await db.startWorkout(planId);
  const state = await db.listState();
  await db.saveWorkoutSet({ workout_exercise_id: state.workoutExercises[0].id, set_number: 1, actual_reps: 10, actual_weight: 50, actual_rir: 2 });
  await db.updateWorkoutSession(sessionId, { current_exercise: 0, current_set: 2, rest_end_at: '2026-10-01T08:01:30.000Z', rest_paused_seconds: null });
  storage.set('zuocai.activeWorkoutSession', sessionId);
}

test('actual App starts with recorded sets and restores the running rest after background', async () => {
  const app = await createAppHarness({ beforeStart: ongoing });
  assert.equal(app.document.querySelector('#fatal').hidden, true, app.document.querySelector('#fatal-message').textContent);
  assert.equal(app.document.querySelector('#workout-dialog').open, true);
  assert.ok(app.document.querySelector('#rest-countdown'));
  await app.emit('appStateChange', { isActive: false });
  app.advance(30);
  await app.emit('appStateChange', { isActive: true });
  await app.tick();
  assert.match(app.document.querySelector('#rest-countdown').textContent, /1:00/);
  assert.equal((await app.db.listState()).workoutSessions[0].rest_end_at, '2026-10-01T08:01:30.000Z');
  assert.equal(app.errors.length, 0);
});

test('closing the training page keeps it closed after the rest expires', async () => {
  const app = await createAppHarness({ beforeStart: ongoing });
  await app.emit('backButton', { canGoBack: false });
  assert.equal(app.document.querySelector('#workout-dialog').open, false);
  app.advance(100);
  await app.tick();
  assert.equal(app.document.querySelector('#workout-dialog').open, false);
  assert.equal((await app.db.listState()).workoutSessions[0].status, 'in_progress');
});

test('pause and resume lifecycle restores the same absolute rest deadline', async () => {
  const app = await createAppHarness({ beforeStart: ongoing });
  const before = (await app.db.listState()).workoutSessions[0];
  await app.emit('pause');
  app.advance(20);
  await app.emit('resume');
  const after = (await app.db.listState()).workoutSessions[0];
  assert.equal(after.rest_end_at, before.rest_end_at);
  assert.equal(app.document.querySelector('#workout-dialog').open, true);
  assert.match(app.document.querySelector('#rest-countdown').textContent, /1:10/);
});

test('a group and its next rest are committed together', async () => {
  const app = await createAppHarness({ beforeStart: async ({ db, storage }) => {
    const planId = await db.saveFitnessPlan({ name: '推日', exercises: [{ name: '卧推', recommended_sets: 2, recommended_reps_min: 8, recommended_reps_max: 12, rest_seconds: 90 }] });
    const sessionId = await db.startWorkout(planId);
    storage.set('zuocai.activeWorkoutSession', sessionId);
  }});
  const form = app.document.querySelector('#set-form');
  assert.ok(form);
  await app.submit({ reps: 10, weight: 50, rir: 2 });
  const state = await app.db.listState();
  assert.equal(state.workoutSets.length, 1);
  assert.equal(state.workoutSessions[0].current_set, 2);
  assert.ok(state.workoutSessions[0].rest_end_at);
});

test('delayed foreground read does not erase the next rest saved meanwhile', async () => {
  let release, held = false, interceptEnabled = false;
  const app = await createAppHarness({
    intercept: async (kind, sql) => {
      if (interceptEnabled && !held && kind === 'query' && sql === 'SELECT * FROM workout_sessions ORDER BY started_at DESC') {
        held = true;
        await new Promise(resolve => { release = resolve; });
      }
    },
    beforeStart: async ({ db, storage }) => {
      const pid = await db.saveFitnessPlan({ name: '推日', exercises: [{ name: '卧推', recommended_sets: 3, recommended_reps_min: 8, recommended_reps_max: 12, rest_seconds: 120 }] });
      storage.set('zuocai.activeWorkoutSession', await db.startWorkout(pid));
    },
  });
  interceptEnabled = true;
  await app.emit('pause');
  await app.emit('resume');
  assert.equal(held, true);
  const saving = app.submit({ reps: 12, weight: 40, rir: 2 });
  await app.flush();
  // A shared SQLite connection must finish the held read before starting a write.
  release();
  await saving;
  await app.flush();
  await app.tick();
  assert.ok(app.document.querySelector('#rest-countdown'), 'stale read removed the entire rest card');
  assert.match(app.document.querySelector('#rest-countdown').textContent, /2:00/);
  assert.ok((await app.db.listState()).workoutSessions[0].rest_end_at);
});
