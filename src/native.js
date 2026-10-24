import { LocalNotifications } from '@capacitor/local-notifications';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { buildNotificationRecords } from './notification-model.js';
export { buildNotificationRecords } from './notification-model.js';

export async function ensureNotificationPermission() {
  let permission = await LocalNotifications.checkPermissions();
  if (permission.display === 'prompt') permission = await LocalNotifications.requestPermissions();
  return permission.display === 'granted';
}

export async function clearAllNotifications() {
  const pending = await LocalNotifications.getPending();
  if (pending.notifications.length) await LocalNotifications.cancel({ notifications:pending.notifications.map(item => ({ id:item.id })) });
}

export const TEST_NOTIFICATION_ID = 2147483647;

function pendingTime(notification) {
  const value = notification.schedule?.at;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

export async function rescheduleNotifications(tasks, plans, requestPermission = false) {
  const permission = requestPermission ? await LocalNotifications.requestPermissions() : await LocalNotifications.checkPermissions();
  const permitted = permission.display === 'granted';
  const records = buildNotificationRecords(tasks, plans);
  if (!permitted) return { permitted, records:[] };

  const pending = (await LocalNotifications.getPending()).notifications || [];
  const ordinaryPending = pending.filter(item => item.id !== TEST_NOTIFICATION_ID);
  const desired = new Map(records.map(record=>[record.notification_id,record]));
  const matches = (pending,record) => pendingTime(pending) === Date.parse(record.scheduled_at) && pending.title === record.title && pending.body === record.body;
  // Keep unchanged future alarms. Cancelling the whole set on every resume
  // needlessly creates a gap in which a nearby reminder may be lost.
  const remove = ordinaryPending.filter(item=>!desired.has(item.id)||!matches(item,desired.get(item.id)));
  const existing = new Map(ordinaryPending.map(item=>[item.id,item]));
  const add = records.filter(item=>!existing.has(item.notification_id)||!matches(existing.get(item.notification_id),item));
  if (remove.length) await LocalNotifications.cancel({ notifications:remove.map(item => ({ id:item.id })) });
  if (add.length) await LocalNotifications.schedule({ notifications:add.map(item => ({ id:item.notification_id,title:item.title,body:item.body,schedule:{ at:new Date(item.scheduled_at),allowWhileIdle:true },smallIcon:'ic_stat_todo' })) });

  const verified = new Map(((await LocalNotifications.getPending()).notifications || []).map(item => [item.id, item]));
  const registered = records.filter(record => pendingTime(verified.get(record.notification_id) || {}) === new Date(record.scheduled_at).getTime());
  return { permitted, records:registered, expectedCount:records.length };
}

export async function scheduleTestNotification() {
  const permission = await LocalNotifications.checkPermissions();
  if (permission.display !== 'granted') throw new Error('请先允许 zuocai 发送通知。');
  const existing = (await LocalNotifications.getPending()).notifications || [];
  if (existing.some(item => item.id === TEST_NOTIFICATION_ID)) await LocalNotifications.cancel({ notifications:[{ id:TEST_NOTIFICATION_ID }] });
  const at = new Date(Date.now() + 15000);
  await LocalNotifications.schedule({ notifications:[{ id:TEST_NOTIFICATION_ID, title:'zuocai 测试提醒', body:'如果你看到了这条通知，说明手机可以接收 zuocai 的本地提醒。', schedule:{ at, allowWhileIdle:true }, smallIcon:'ic_stat_todo' }] });
  const pending = (await LocalNotifications.getPending()).notifications || [];
  if (!pending.some(item => item.id === TEST_NOTIFICATION_ID)) throw new Error('测试提醒没有进入 Android 待触发列表。');
  return at;
}

export async function exportBackup(data) {
  const filename = `zuocai-backup-${new Date().toISOString().slice(0,10)}.json`;
  const result = await Filesystem.writeFile({ path:filename, data:JSON.stringify(data,null,2), directory:Directory.Cache, encoding:Encoding.UTF8 });
  await Share.share({ title:'zuocai 备份', text:'普通 JSON 文件包含你的本地数据，请妥善保管。', url:result.uri, dialogTitle:'导出 zuocai 备份' });
  return filename;
}

export async function exportWorkoutStatsCsv(csv) {
  const filename = `zuocai-workout-stats-${new Date().toISOString().slice(0,10)}.csv`;
  const result = await Filesystem.writeFile({ path:filename, data:`\uFEFF${csv}`, directory:Directory.Cache, encoding:Encoding.UTF8 });
  // Android may report a cancelled share sheet after the file has already been
  // handed to the file manager. The file write is the export operation, so do
  // not turn that optional handoff into a false failure.
  try { await Share.share({ title:'zuocai 训练统计', files:[result.uri], dialogTitle:'导出训练统计' }); } catch {}
  return filename;
}
