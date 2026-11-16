/**
 * Whether an app's tile is on somebody's portal home. #274, Clients TDD 2.1 and 12.2.
 *
 * Most apps are everybody's and declare nothing: Rota and the directory are on every portal
 * home. An app that is only some people's implements this, and the composition root registers
 * it with {@link portalRoutes}. Core declares the shape and never imports an app, as with
 * `EmployeeChangeSubscriber`.
 *
 * An implementation must answer from the same policy that guards the app's own endpoints
 * (Clients NFR CLI SEC 06), so that a tile is never shown to somebody every route refuses, nor
 * hidden from somebody it lets in.
 */

import type { Actor } from '../auth/actor.js';

export interface AppVisibility {
  /** The app's name, as the portal home knows it: 'clients'. */
  readonly app: string;
  /** Whether this person's portal home shows the app. Never throws for a refusal. */
  canSee(actor: Actor): Promise<boolean>;
}

/** The apps among these that this person may see, in the order given. */
export async function visibleApps(actor: Actor, apps: readonly AppVisibility[]): Promise<string[]> {
  const answers = await Promise.all(apps.map((one) => one.canSee(actor)));

  return apps.filter((_one, at) => answers[at]).map((one) => one.app);
}
