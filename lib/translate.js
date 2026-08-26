// Kept as a thin re-export so older call sites keep working. The engines
// themselves now live in lib/engine/ behind a registry — see
// lib/engine/index.js for why the seam exists.
module.exports = require('./engine');
