const { spawn } = require('child_process');

const child = spawn('C:/Users/金城武/.workbuddy-ai/binaries/node/versions/22.22.2-6/node.exe', ['server.js'], {
  cwd: 'C:/Users/金城武/WorkBuddy AI/2026-10-28-18-19-20/store-app',
  detached: true,
  stdio: 'ignore'
});

child.unref();
console.log('Server started with PID:', child.pid);
