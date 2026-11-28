const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('DesktopApp', {
  isDesktop: true,
  platform: process.platform
});
