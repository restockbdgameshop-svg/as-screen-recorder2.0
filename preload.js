const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = ['settings:get', 'settings:set', 'displays:list', 'folder:choose', 'file:saveCopy', 'shell:open', 'shell:show', 'area:select', 'rec:start'];
const SEND = ['rec:stop', 'rec:pause', 'rec:resume', 'bar:pause', 'bar:resume', 'bar:stop', 'area:result',
  'recorder:ready', 'recorder:started', 'recorder:error', 'recorder:chunk', 'recorder:stopped', 'recorder:fatal'];
const ON = ['rec:warn', 'rec:finalizing', 'rec:done', 'rec:failed', 'bar:tick', 'bar:warn',
  'recorder:start', 'recorder:stop', 'recorder:pause', 'recorder:resume'];

contextBridge.exposeInMainWorld('asr', {
  invoke: (ch, ...a) => INVOKE.includes(ch) ? ipcRenderer.invoke(ch, ...a) : Promise.reject(new Error('blocked channel')),
  send: (ch, ...a) => { if (SEND.includes(ch)) ipcRenderer.send(ch, ...a); },
  on: (ch, fn) => { if (ON.includes(ch)) { const h = (e, d) => fn(d); ipcRenderer.on(ch, h); return () => ipcRenderer.removeListener(ch, h); } }
});
