/** The portal home, over HTTP. #274. */

import { type NextFunction, type Request, type Response, Router } from 'express';
import { actorOf } from '../http/identify.js';
import { type AppVisibility, visibleApps } from './app-visibility.js';

export interface PortalRoutes {
  /** Every app whose tile is only some people's. Apps that are everybody's are not listed. */
  apps: readonly AppVisibility[];
}

export function portalRoutes({ apps }: PortalRoutes): Router {
  const routes = Router();

  /**
   * Which of the apps that are only some people's this person may see.
   *
   * Asked here, of core, rather than of each app, so that an app that answers 404 to everybody
   * without access is not asked a question it would have to answer with something else
   * (Clients NFR CLI SEC 04). An app not in the list is either everybody's or nobody's; this
   * names only those this person has.
   */
  routes.get('/me/apps', (_request: Request, response: Response, next: NextFunction) => {
    void visibleApps(actorOf(response), apps)
      .then((visible) => {
        response.json({ apps: visible });
      })
      .catch(next);
  });

  return routes;
}
