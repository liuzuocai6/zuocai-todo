import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRestState, restState } from '../src/workout-rest.js';

test('rest state survives SQLite string values after app restart', () => {
  const end = '2026-10-01T12:01:30.000Z';
  const state = restState({ rest_end_at: end, rest_paused_seconds: null }, Date.parse('2026-10-01T12:00:00.000Z'));
  assert.equal(state.active, true);
  assert.equal(state.running, true);
  assert.equal(state.remainingSeconds, 90);
  assert.equal(normalizeRestState({ rest_end_at: null, rest_paused_seconds: '45' }).pausedSeconds, 45);
});

test('expired rest remains visible as completed and paused rest remains active', () => {
  const expired = restState({ rest_end_at: '2026-10-01T11:59:00.000Z', rest_paused_seconds: null }, Date.parse('2026-10-01T12:00:00.000Z'));
  assert.equal(expired.active, false);
  assert.equal(expired.remainingSeconds, 0);
  const paused = restState({ rest_end_at: null, rest_paused_seconds: '30' }, Date.parse('2026-10-01T12:00:00.000Z'));
  assert.equal(paused.active, true);
  assert.equal(paused.paused, true);
  assert.equal(paused.pausedSeconds, 30);
});
