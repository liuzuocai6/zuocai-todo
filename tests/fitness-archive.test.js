import test from 'node:test';
import assert from 'node:assert/strict';
import { activePlans, archivedPlans, activeSessions, archivedSessions } from '../src/fitness-archive.js';

test('archive lists contain only archived plans and ended workouts',()=>{
  const plans=[{id:'active',archived:'0'},{id:'archived',archived:'1'}];
  const sessions=[{id:'active',status:'completed',archived:'0'},{id:'archived',status:'incomplete',archived:'1'},{id:'ongoing',status:'in_progress',archived:false}];
  assert.deepEqual(activePlans(plans).map(x=>x.id),['active']);
  assert.deepEqual(archivedPlans(plans).map(x=>x.id),['archived']);
  assert.deepEqual(activeSessions(sessions).map(x=>x.id),['active','ongoing']);
  assert.deepEqual(archivedSessions(sessions).map(x=>x.id),['archived']);
  sessions[0].archived=true;
  assert.deepEqual(archivedSessions(sessions).map(x=>x.id),['active','archived']);
  sessions[0].archived=false;
  assert.deepEqual(activeSessions(sessions).map(x=>x.id),['active','ongoing']);
});
