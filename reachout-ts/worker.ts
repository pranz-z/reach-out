/**
 * Queue worker — `npm run worker`. Claims due jobs from the jobs table
 * and runs the matching handler, with a heartbeat the UI checks to warn
 * when the worker is down (same contract as Laravel's queue_heartbeat).
 */
import './lib/env';
import { registerHandlers } from './lib/jobs';
import { workLoop } from './lib/queue';
import { Setting } from './lib/settings';

registerHandlers();

Setting.set('queue_heartbeat', new Date().toISOString());
const heartbeat = setInterval(() => Setting.set('queue_heartbeat', new Date().toISOString()), 30_000);

console.log('[worker] reachout-ts queue worker running');
workLoop().finally(() => clearInterval(heartbeat));
