/**
 * @file offline-batches.js
 * @description Reexporta o fixture do harness como ESM default, para as specs de
 * integração o importarem sem depender da flag de import de JSON.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const batches = require('../../harness/fixtures/offline-events-batch.json');

export default batches;
