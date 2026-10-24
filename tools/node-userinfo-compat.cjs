// Capacitor's terminal helper asks Node for the Windows account shell. The
// bundled runtime can report ENOMEM in restricted sessions, so generation uses
// this harmless fallback. It is never included in the Android application.
const os = require('node:os');
const original = os.userInfo;
os.userInfo = (...args) => {
  try { return original(...args); }
  catch { return { username:process.env.USERNAME || 'user', uid:-1, gid:-1, shell:'powershell.exe', homedir:process.env.USERPROFILE || process.cwd() }; }
};
