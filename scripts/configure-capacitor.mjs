import fs from 'node:fs';

const serverUrl = (process.env.CAPACITOR_SERVER_URL || 'http://10.0.2.2:3000').replace(/\/+$/, '');
if (!/^https?:\/\//.test(serverUrl)) throw new Error('CAPACITOR_SERVER_URL debe ser una URL HTTP(S)');

const config = {
  appId: 'com.mvisions.batallapsicologica',
  appName: 'Batalla Psicológica',
  webDir: 'public',
  bundledWebRuntime: false,
  server: { url: serverUrl, cleartext: serverUrl.startsWith('http://') },
  plugins: {
    SocialLogin: {
      providers: { google: true, facebook: false, apple: false, twitter: false },
      logLevel: 1,
    },
  },
};

fs.writeFileSync('capacitor.config.json', `${JSON.stringify(config, null, 2)}\n`);
console.log(`Capacitor apunta a ${serverUrl}`);
