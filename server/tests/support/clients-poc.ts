import type { Client } from 'pg';

/**
 * Puts a deal into a POC of its own, straight in the database, as signing its contract does
 * (#285): through Contract signed with a POC, a POC made for its client and line and run by its
 * owner, and on into it. For a test that needs a deal in its POC without going the whole way
 * there through the API. No stage history is written.
 *
 * Inside the caller's transaction, since the database refuses a deal with a POC left at Contract
 * signed only at the commit (`clients_opportunity_signing_starts_its_poc`). See
 * {@link intoItsPoc} for a caller with none.
 */
export async function intoItsPocWithin(
  db: Client,
  dealId: string,
  startedOn = 'CURRENT_DATE',
): Promise<string> {
  await db.query(
    `UPDATE clients_opportunity SET has_poc = true, stage = 'CONTRACT_SIGNED' WHERE id = $1`,
    [dealId],
  );

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO clients_poc
            (client_id, line_id, client_type_id, cs_lead_id, started_on, decision_on, created_by)
     SELECT o.client_id, p.line_id, c.type_id, o.owner_id, ${startedOn}, ${startedOn} + 70,
            o.owner_id
       FROM clients_opportunity o
       JOIN clients_product p ON p.id = o.product_id
       JOIN clients_client c ON c.id = o.client_id
      WHERE o.id = $1
     RETURNING id`,
    [dealId],
  );

  await db.query(`UPDATE clients_opportunity SET stage = 'POC', poc_id = $2 WHERE id = $1`, [
    dealId,
    rows[0].id,
  ]);

  return rows[0].id;
}

/** {@link intoItsPocWithin}, in a transaction of its own, committed. */
export async function intoItsPoc(db: Client, dealId: string): Promise<string> {
  await db.query('BEGIN');
  try {
    const pocId = await intoItsPocWithin(db, dealId);
    await db.query('COMMIT');

    return pocId;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}
