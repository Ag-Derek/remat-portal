import type { Client } from 'pg';

/**
 * Ticks every check of a deal's in `groups`, by default its criteria and pre-POC gates, that is
 * not ticked yet, straight in the database, put down to the deal's owner (#284). For a test about
 * what comes after a gate, rather than the gate itself, which clients-checklists-api.test.ts and
 * clients-stages-api.test.ts drive by hand.
 *
 * A deal is given its checks as it first leaves Discovery, so one still at Discovery has none to
 * tick: move it on first.
 */
export async function tickEveryCheck(
  db: Client,
  dealId: string,
  groups: readonly string[] = ['QUALIFICATION', 'PRE_POC'],
): Promise<void> {
  const { rows } = await db.query<{ copied: boolean }>(
    'SELECT checklist_copied_at IS NOT NULL AS copied FROM clients_opportunity WHERE id = $1',
    [dealId],
  );
  if (rows[0]?.copied !== true) {
    throw new Error('The deal has no checklist yet: move it out of Discovery first.');
  }

  await db.query(
    `INSERT INTO clients_tick (check_id, ticked, ticked_by)
     SELECT k.id, true, o.owner_id
       FROM clients_check k
       JOIN clients_opportunity o ON o.id = k.opportunity_id
      WHERE k.opportunity_id = $1
        AND k.grp = ANY($2::text[])
        AND NOT coalesce((SELECT t.ticked FROM clients_tick t WHERE t.check_id = k.id
                           ORDER BY t.ticked_at DESC, t.id DESC LIMIT 1), false)`,
    [dealId, groups],
  );
}
