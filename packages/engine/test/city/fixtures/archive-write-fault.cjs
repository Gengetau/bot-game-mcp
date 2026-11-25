// Test-only preload for the S2 downgrade script: makes writes to the archive temp file short.
// ARCHIVE_WRITE_FAULT=short  -> every write to the archive temp file writes at most 16 bytes (a full write needs a loop).
// ARCHIVE_WRITE_FAULT=stall  -> the first write writes 16 bytes, later writes write 0 bytes (the archive can never be completed).
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');

const originalWrite = fs.writeSync;
let calls = 0;
fs.writeSync = function (fd, buffer, ...args) {
  let name = '';
  try {
    name = fs.readlinkSync('/proc/self/fd/' + fd);
  } catch {
    /* not a regular fd */
  }
  const mode = process.env.ARCHIVE_WRITE_FAULT;
  if (mode && name.includes('.s2-archive-') && name.includes('.tmp-') && typeof buffer !== 'string') {
    const offset = typeof args[0] === 'number' ? args[0] : 0;
    const length = Math.min(16, args[1] ?? buffer.length - offset);
    calls += 1;
    if (mode === 'stall' && calls > 1) return 0;
    return originalWrite.call(this, fd, buffer, offset, length);
  }
  return originalWrite.call(this, fd, buffer, ...args);
};
syncBuiltinESMExports();
