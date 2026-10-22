import { auditLog } from './db/schema';
import { db } from './db';
import { ts } from './config';

/** Port of AuditLog::record — every meaningful action leaves a row. */
export function audit(entity: string, entityId: number | null, action: string, meta: Record<string, unknown> = {}) {
  db().insert(auditLog).values({
    entity, entityId, action, meta, createdAt: ts(),
  }).run();
}
