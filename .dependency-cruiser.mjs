/**
 * Architectural guardrails, scripted from the PROJECT-KNOWLEDGE conventions.
 * Runs in the pre-commit gate (npm run audit:boundaries) so layer drift is
 * caught before it ships.
 *
 * dependency-cruiser v18 quirks learned the hard way (keep these!):
 *  - rule lists live under `forbidden` (old `rule` key is gone);
 *  - do NOT add an `options` object here: on this toolchain it makes
 *    depcruise prune every edge into node_modules (rules stop seeing
 *    external packages) and can even crash the run;
 *  - external package edges resolve to `<ws>/node_modules/<pkg>/...`, so
 *    `to.path` patterns must match a path SEGMENT, not just a name.
 */

/** Files sanctioned to import react-router (PROJECT-KNOWLEDGE glue list). */
const FRONTEND_GLUE =
  '^frontend/src/(App\\.tsx|router\\.tsx|pages/(AppLayout|ChatPage)\\.tsx|actions/)';

export default {
  forbidden: [
    {
      name: 'frontend-purity-react-router-in-glue-only',
      comment:
        'react-router belongs to the glue files only; pages/components/services stay framework-free (scripted version of the PROJECT-KNOWLEDGE grep rule).',
      severity: 'error',
      from: { path: '^frontend/src/', pathNot: FRONTEND_GLUE },
      to: { path: '(^|/)react-router' },
    },
    {
      name: 'frontend-purity-ai-sdk-in-glue-or-controller-only',
      comment:
        '@ai-sdk/react is sanctioned in glue + the ChatController folder (the streaming component and its per-tab chat registry), nowhere else.',
      severity: 'error',
      from: {
        path: '^frontend/src/',
        pathNot: `${FRONTEND_GLUE}|components/chat/ChatController/`,
      },
      to: { path: '(^|/)@ai-sdk/react' },
    },
    {
      name: 'backend-kysely-only-in-db-layer',
      comment:
        'ADR-0004: only backend/src/db/** may touch Kysely; services and routes stay query-builder free.',
      severity: 'error',
      from: { path: '^backend/src/', pathNot: '^backend/src/db/' },
      to: { path: '(^|/)kysely' },
    },
    {
      name: 'backend-db-singleton-only-in-queries',
      comment:
        'The app-wide db singleton is imported only by the query modules (.test.ts files provision a real DB and are exempt). Services compose queries — never the singleton.',
      severity: 'error',
      from: {
        path: '^backend/src/',
        pathNot: '^backend/src/db/|\\.test\\.ts$',
      },
      to: { path: '^@db/db$|^backend/src/db/db(\\.ts)?$' },
    },
  ],
};
