'use strict';

// CJS shim for uuid v13 (pure ESM) — used by Jest which runs in CommonJS mode.
// crypto.randomUUID is available in Node 14.17+ and produces RFC 4122 v4 UUIDs.
const crypto = require('crypto');

module.exports = {
  v4: () => crypto.randomUUID(),
};
