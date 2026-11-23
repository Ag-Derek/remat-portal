import type { Client } from 'pg';

/**
 * Every leave type's chain as it was while HR approved leave: manager then HR, and HR then the
 * Chief Executive for the two unpaid types.
 *
 * HR is out of leave approval for now and a migrated database has the chains without it, but
 * the HR desk is kept, so the suites that prove how a chain naming it routes, decides and
 * notifies still run against it. Each file has a database of its own, so replacing every chain
 * here touches no other suite.
 */
export async function hrStillApprovesLeave(admin: Client): Promise<void> {
  await admin.query('BEGIN');
  await admin.query('DELETE FROM leave_type_approval_step');
  await admin.query('SELECT ensure_statutory_approval_chains(true)');
  await admin.query('COMMIT');
}
