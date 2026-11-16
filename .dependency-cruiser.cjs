/**
 * Which folder may import which. Run by `npm run lint`.
 *
 * core/ never imports apps/, no app imports another, and neither imports the
 * composition root (main.ts, app.ts), which would be a way round both.
 *
 * Known compromises, each to be resolved in its own change:
 *
 * 1. core/db/transaction.ts builds leave's repositories into the shared bundle.
 *    Resolved by making the bundle composable, each app registering its own
 *    repositories. Allowlisted below, for *.db.ts files only.
 * 2. core/http/problems.ts imports AttachmentTooLarge from leave. Resolved by each
 *    app registering its own error-to-status mappings. Allowlisted below, for that
 *    one file only.
 * 3. LeaveThatFollows in core/organisation/employee/employee.ts is named for one
 *    app. Not a violation: core declares it, leave implements it, the composition
 *    root wires them. Its shape is right; only the name is wrong. Resolved by
 *    renaming it EmployeeChangeSubscriber, with onManagerChanged and
 *    onEmployeeExited, each app registering its own. Certain rather than likely:
 *    the compliance register needs exactly these two (re-route the items a
 *    manager's reports own when the manager changes, reassign rather than orphan
 *    a leaver's items), and leaver reassignment is an open defect in leave today.
 *    Goes with 1, which is the same "each app registers its own" pattern.
 */
module.exports = {
  forbidden: [
    {
      name: 'core-not-to-apps',
      comment: 'core/ may never import from apps/. Compromises 1 and 2 are excepted here.',
      severity: 'error',
      from: {
        path: '^server/src/core/',
        pathNot: '^server/src/core/(db/transaction|http/problems)\\.ts$',
      },
      to: { path: '^server/src/apps/' },
    },
    {
      name: 'core-transaction-only-to-repositories',
      comment: 'Compromise 1. transaction.ts may reach an app only for its repositories.',
      severity: 'error',
      from: { path: '^server/src/core/db/transaction\\.ts$' },
      to: { path: '^server/src/apps/', pathNot: '^server/src/apps/leave/.+\\.db\\.ts$' },
    },
    {
      name: 'core-problems-only-to-attachment',
      comment: 'Compromise 2. problems.ts may reach an app only for AttachmentTooLarge.',
      severity: 'error',
      from: { path: '^server/src/core/http/problems\\.ts$' },
      to: {
        path: '^server/src/apps/',
        pathNot: '^server/src/apps/leave/leave-request/attachment\\.ts$',
      },
    },
    {
      name: 'app-not-to-other-app',
      comment: 'No app may import from another app.',
      severity: 'error',
      from: { path: '^server/src/apps/([^/]+)/' },
      to: { path: '^server/src/apps/', pathNot: '^server/src/apps/$1/' },
    },
    {
      name: 'compliance-not-to-roles',
      comment:
        "Compliance asks actor.isSysAdmin and never reads Rota's role codes. #241. " +
        'The rest of that rule, which no import shows, is in tests/unit/one-actor.test.ts.',
      severity: 'error',
      from: { path: '^server/src/apps/compliance/' },
      to: { path: '^server/src/core/identity/role/' },
    },
    {
      name: 'clients-not-to-roles',
      comment:
        "Clients asks actor.isSysAdmin and never reads Rota's role codes, as compliance. #274. " +
        'The rest of that rule, which no import shows, is in tests/unit/one-actor.test.ts.',
      severity: 'error',
      from: { path: '^server/src/apps/clients/' },
      to: { path: '^server/src/core/identity/role/' },
    },
    {
      name: 'not-to-composition-root',
      comment: 'Only main.ts and app.ts assemble everything; nothing imports them back.',
      severity: 'error',
      from: { path: '^server/src/(core|apps)/' },
      to: { path: '^server/src/(main|app)\\.ts$' },
    },
  ],
  options: {
    // Type-only imports count: a type from leave is still knowledge of leave.
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    includeOnly: '^server/src/',
    doNotFollow: { path: 'node_modules' },
  },
};
