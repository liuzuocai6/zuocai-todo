import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';
import { SQLiteConnection } from '../../node_modules/@capacitor-community/sqlite/dist/esm/definitions.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const stencil = readdirSync(resolve(root, 'node_modules/.pnpm')).find(name => name.startsWith('@stencil+core@'));
const { MockWindow } = require(resolve(root, 'node_modules/.pnpm', stencil, 'node_modules/@stencil/core/mock-doc/index.cjs'));

export async function createAppHarness({ database = new DatabaseSync(':memory:'), storage = new Map(), at = '2026-10-01T08:00:00.000Z', beforeStart, intercept = async () => {}, confirmation = () => true } = {}) {
  const window = new MockWindow(readFileSync(resolve(root, 'index.html'), 'utf8'));
  const document = window.document;
  let clock = Date.parse(at);
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const timers = new Map();
  const listeners = new Map();
  const errors = [];
  const minimized = { count:0 };
  let nextTimer = 1;
  const localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
  };
  // Use the installed Capacitor wrapper, including its default transaction=true.
  // Native SQL execution remains local SQLite; nested transactions must fail.
  async function transact(enabled, operation) {
    if (enabled) database.exec('BEGIN');
    try {
      const result = await operation();
      if (enabled) database.exec('COMMIT');
      return result;
    } catch (error) {
      if (enabled) database.exec('ROLLBACK');
      throw error;
    }
  }
  const CapacitorSQLite = {
    checkConnectionsConsistency: async () => ({ result: false }),
    createConnection: async () => {},
    open: async () => database.exec('PRAGMA foreign_keys=ON'),
    query: async ({statement:sql,values=[]}) => { const result = { values: database.prepare(sql).all(...values) }; await intercept('query', sql, values); return result; },
    run: async ({statement:sql,values=[],transaction=true}) => transact(transaction, async () => {
      await intercept('run', sql, values);
      const result = database.prepare(sql).run(...values);
      return { changes: { changes: Number(result.changes), lastId: Number(result.lastInsertRowid) } };
    }),
    execute: async ({statements,transaction=true}) => transact(transaction, () => { database.exec(statements); return { changes: { changes: 0 } }; }),
    beginTransaction: async () => database.exec('BEGIN'),
    commitTransaction: async () => database.exec('COMMIT'),
    rollbackTransaction: async () => database.exec('ROLLBACK'),
  };
  // Dynamic workout forms need the same browser APIs as the initial forms.
  Object.defineProperty(window.HTMLElement.prototype, 'elements', { configurable: true, get() { return Object.fromEntries([...this.querySelectorAll('[name]')].map(el => [el.getAttribute('name'), el])); } });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLElement.prototype.before = function(node) { this.parentNode.insertBefore(node,this); };
  window.HTMLElement.prototype.after = function(node) { this.parentNode.insertBefore(node,this.nextSibling); };
  for (const form of document.querySelectorAll('form')) {
    form.reset = () => {};
  }
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.open = false;
    dialog.showModal = () => { dialog.open = true; dialog.setAttribute('open',''); };
    dialog.close = () => { dialog.open = false; dialog.removeAttribute('open'); };
  }
  const App = {
    addListener: (name, callback) => { const callbacks = listeners.get(name) || []; callbacks.push(callback); listeners.set(name, callbacks); return Promise.resolve({ remove: async () => {} }); },
    minimizeApp: async () => { minimized.count++; },
  };
  const context = vm.createContext({
    window, document, localStorage, Date: Clock, console, crypto: globalThis.crypto,
    confirm: confirmation,
    setInterval: (callback, ms) => { const id = nextTimer++; timers.set(id, { callback, ms }); return id; },
    clearInterval: id => timers.delete(id),
    setTimeout: () => nextTimer++, clearTimeout: () => {},
    requestAnimationFrame: callback => { try { callback(); } catch (error) { errors.push(error); } },
  });
  const moduleCache = new Map();
  const mocks = {
    '@capacitor/core': { Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' } },
    '@capacitor/app': { App },
    '@capacitor-community/sqlite': { CapacitorSQLite, SQLiteConnection },
    '@capacitor/local-notifications': { LocalNotifications: { checkPermissions: async () => ({ display: 'denied' }) } },
    'native.js': { rescheduleNotifications: async () => ({ records: [], expectedCount: 0 }), scheduleTestNotification: async () => new Clock(), exportBackup: async () => 'backup.json', exportWorkoutStatsCsv: async () => 'workout.csv', clearAllNotifications: async () => {} },
  };
  async function load(path) {
    if (moduleCache.has(path)) return moduleCache.get(path);
    const exports = mocks[path] || (path.endsWith('native.js') ? mocks['native.js'] : path.endsWith('.css') ? {} : null);
    const module = exports
      ? new vm.SyntheticModule(Object.keys(exports), function () { for (const [name, value] of Object.entries(exports)) this.setExport(name, value); }, { context, identifier: path })
      : new vm.SourceTextModule(readFileSync(path, 'utf8'), { context, identifier: path });
    moduleCache.set(path, module);
    await module.link((specifier, parent) => load(specifier.startsWith('.') ? resolve(dirname(parent.identifier), specifier) : specifier));
    return module;
  }
  const dbModule = await load(resolve(root, 'src/db.js'));
  await dbModule.evaluate();
  await dbModule.namespace.initializeDatabase();
  if (beforeStart) await beforeStart({ database, db: dbModule.namespace, storage });
  const appModule = await load(resolve(root, 'src/app.js'));
  await appModule.evaluate();
  const flush = async () => { for (let i = 0; i < 1500; i++) await Promise.resolve(); };
  await flush();
  return {
    window, document, database, storage, timers, errors, minimized, db: dbModule.namespace,
    flush,
    advance: seconds => { clock += seconds * 1000; },
    tick: async () => { for (const timer of [...timers.values()]) timer.callback(); await flush(); },
    emit: async (name, value) => { for (const callback of listeners.get(name) || []) callback(value); await flush(); },
    click: async selector => { const element = document.querySelector(selector); if (!element) throw new Error(`Missing element: ${selector}`); element.click(); await flush(); },
    submit: async values => { const form = document.querySelector('#set-form'); for (const [key, value] of Object.entries(values)) form.elements[key].value = String(value); const result = await form.onsubmit({ preventDefault() {}, currentTarget: form }); await flush(); return result; },
    dispose: () => timers.clear(),
    evaluate: code => vm.runInContext(code, context),
  };
}
