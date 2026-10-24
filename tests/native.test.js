import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNotificationRecords } from '../src/notification-model.js';

test('builds start and due notifications', () => {
  const tasks=[{id:'t',title:'报告',deadline:'2026-09-22',completed_at:null}];
  const plans=[{id:'p',task_id:'t',plan_date:'2026-09-21',start_time:'12:00',completed_at:null}];
  const records=buildNotificationRecords(tasks,plans,new Date('2026-09-21T10:00:00'));
  assert.equal(records.length,2);
  assert.equal(records[0].kind,'start');
  const scheduled = new Date(records[0].scheduled_at);
  assert.equal(scheduled.getHours(),11);
  assert.equal(scheduled.getMinutes(),50);
});

test('completed instances have no start reminder', () => {
  const tasks=[{id:'t',title:'报告',deadline:null,completed_at:null}];
  const plans=[{id:'p',task_id:'t',plan_date:'2026-09-21',start_time:'12:00',completed_at:'done'}];
  assert.equal(buildNotificationRecords(tasks,plans,new Date('2026-09-21T10:00:00')).length,0);
});

test('start reminder is ten minutes before the chosen local time', () => {
  const tasks=[{id:'t',title:'下午任务',deadline:null,completed_at:null}];
  const plans=[{id:'p',task_id:'t',plan_date:'2026-09-26',start_time:'13:41',completed_at:null}];
  const [record]=buildNotificationRecords(tasks,plans,new Date('2026-09-26T12:00:00'));
  const when=new Date(record.scheduled_at);
  assert.equal(when.getHours(),13);
  assert.equal(when.getMinutes(),31);
});

test('same-day deadline created after 9 AM has no overdue alarm', () => {
  const tasks=[{id:'t',title:'下午任务',deadline:'2026-09-26',completed_at:null}];
  assert.equal(buildNotificationRecords(tasks,[],new Date('2026-09-26T12:00:00')).length,0);
});

test('deadline reminder exists once before 09:00 and disappears after 09:00', () => {
  const tasks=[{id:'t',title:'截止事项',deadline:'2026-09-26',completed_at:null}];
  assert.equal(buildNotificationRecords(tasks,[],new Date('2026-09-26T08:59:00')).length,1);
  assert.equal(buildNotificationRecords(tasks,[],new Date('2026-09-26T09:00:00')).length,0);
});

test('start reminder is not recreated after its ten-minute trigger time', () => {
  const tasks=[{id:'t',title:'下午任务',deadline:null,completed_at:null}];
  const plans=[{id:'p',task_id:'t',plan_date:'2026-09-26',start_time:'13:41',completed_at:null}];
  assert.equal(buildNotificationRecords(tasks,plans,new Date('2026-09-26T13:30:59')).length,1);
  assert.equal(buildNotificationRecords(tasks,plans,new Date('2026-09-26T13:31:00')).length,0);
  assert.equal(buildNotificationRecords(tasks,plans,new Date('2026-09-26T13:35:00')).length,0);
});
