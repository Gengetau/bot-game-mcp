// Test-only preload for the S2 downgrade script: makes writes to the archive temp file short.
// ARCHIVE_WRITE_FAULT=short  -> every write to the archive temp file writes at most 16 bytes (a full write needs a loop).
// ARCHIVE_WRITE_FAULT=stall  -> the first write writes 16 bytes, later writes write 0 bytes (the archive can never be completed).
// The archive temp file's fd is recorded when it is opened, so this works without /proc (macOS, Windows).
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');

const isArchiveTemp = (p) => typeof p === 'string' && p.includes('.s2-archive-') && p.includes('.tmp-');
const archiveFds = new Set();
const originalOpen = fs.openSync;
fs.openSync = function (path, ...args) {
  const fd = originalOpen.call(this, path, ...args);
  if (isArchiveTemp(String(path))) archiveFds.add(fd);
  return fd;
};
const originalClose = fs.closeSync;
fs.closeSync = function (fd, ...args) {
  archiveFds.delete(fd);
  return originalClose.call(this, fd, ...args);
};
const originalWrite = fs.writeSync;
let calls = 0;
fs.writeSync = function (fd, buffer, ...args) {
  const mode = process.env.ARCHIVE_WRITE_FAULT;
  if (mode && archiveFds.has(fd) && typeof buffer !== 'string') {
    const offset = typeof args[0] === 'number' ? args[0] : 0;
    const length = Math.min(16, args[1] ?? buffer.length - offset);
    calls += 1;
    if (mode === 'stall' && calls > 1) return 0;
    return originalWrite.call(this, fd, buffer, offset, length);
  }
  return originalWrite.call(this, fd, buffer, ...args);
};
// A fault that never fired would let the test pass without testing anything: fail the process instead.
process.on('exit', () => {
  if (process.env.ARCHIVE_WRITE_FAULT && calls === 0) {
    process.stderr.write('ARCHIVE_WRITE_FAULT: no archive write was intercepted\n');
    process.exitCode = 97;
  }
});
syncBuiltinESMExports();
