/**
 * The dashboard (#289, Clients SRS CLI 102): read, never written. Anybody with a role's, values
 * and probabilities included (CLI 90).
 *
 * Gathers what the other screens already read, so that the figures here never disagree with
 * theirs: every open deal as the company pipeline reads it, every running POC as the POC list
 * shows it (health and flags worked out the one way), and each client's last contact. The rules
 * that turn those into a dashboard are in dashboard.ts.
 */

import type { Actor } from '../../core/auth/actor.js';
import type { Guard } from '../../core/auth/policy.js';
import { type CalendarDate, currentDate } from '../../core/calendar/time.js';
import { accessOf } from './access.js';
import type { ClientsClientRepository } from './client.db.js';
import { type Dashboard, dashboardOf, type Reassignment } from './dashboard.js';
import type { ClientsOpportunityRepository } from './opportunity.db.js';
import type { PocService } from './poc.service.js';
import { clientsPolicy } from './policy.js';
import type { ClientsRoleRepository } from './role.db.js';
import type { ClientsStandings } from './standing.js';

export class DashboardService {
  constructor(
    private readonly guard: Guard,
    private readonly grants: Pick<ClientsRoleRepository, 'rolesOf'>,
    private readonly opportunities: Pick<ClientsOpportunityRepository, 'companyPipeline'>,
    private readonly clients: Pick<ClientsClientRepository, 'lastContacts' | 'list'>,
    /** The POC list, which asks the same question of whoever asks. */
    private readonly pocs: Pick<PocService, 'list'>,
    /** Whose things need a new owner (CLI 96). */
    private readonly standings: Pick<ClientsStandings, 'of'>,
    /** The company's today, against which a client has gone quiet. */
    private readonly today: () => CalendarDate = () => currentDate(),
  ) {}

  async dashboard(
    actor: Actor,
  ): Promise<
    Omit<Dashboard, 'reassign'> & { reassign: (Reassignment & { mayMoveAll: boolean })[] }
  > {
    const access = await accessOf(actor, this.grants);
    this.guard.enforce(clientsPolicy.read(actor, access));

    const [deals, pocs, contacts, owned] = await Promise.all([
      this.opportunities.companyPipeline(),
      this.pocs.list(actor),
      this.clients.lastContacts(),
      this.clients.list(),
    ]);
    const standings = await this.standings.of([
      ...owned.map((client) => client.owner.id),
      ...deals.map(({ deal }) => deal.owner.id),
    ]);

    const dashboard = dashboardOf(deals, pocs, contacts, this.today(), owned, standings);

    return {
      ...dashboard,
      /* Whether the person reading may move all of each one's things at once: a BD manager. */
      reassign: dashboard.reassign.map((one) => ({
        ...one,
        mayMoveAll: clientsPolicy.reassign(actor, access, 'client', one.person.id).allowed,
      })),
    };
  }
}
