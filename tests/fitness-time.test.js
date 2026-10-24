import test from 'node:test';
import assert from 'node:assert/strict';
import { workoutDuration } from '../src/fitness-time.js';

test('training duration uses session timestamps across midnight and includes breaks',()=>{
  const start='2026-09-28T23:40:00+08:00';
  assert.equal(workoutDuration(start,Date.parse('2026-09-29T00:55:00+08:00')),'1小时15分钟');
  assert.equal(workoutDuration(start,Date.parse('2026-09-28T23:49:59+08:00')),'0小时09分钟');
});

test('incomplete training keeps its ended duration, while active duration follows the current time',()=>{
  const start='2026-09-28T10:00:00+08:00';
  const ended='2026-09-28T10:42:00+08:00';
  assert.equal(workoutDuration(start,Date.parse(ended)),'0小时42分钟');
  assert.equal(workoutDuration(start,Date.parse('2026-09-28T11:00:00+08:00')),'1小时00分钟');
});
