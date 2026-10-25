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
    {
      name: 'backend-queue-started-by-entry-points-only',
      comment:
        'Only the entry points (the API server and the worker process) start the worker; everything else reaches a task through the enqueue function it is handed.',
      severity: 'error',
      from: { path: '^backend/(src|app)/', pathNot: '^backend/app/(server|worker)\\.ts$' },
      to: { path: '^@queue/(worker|index)$|^backend/queue/(worker|index)(\\.ts)?$' },
    },
    {
      name: 'backend-queue-kysely-free',
      comment:
        'Queue code composes queries like a service does; it never builds SQL or holds the db singleton.',
      severity: 'error',
      from: { path: '^backend/queue/', pathNot: '\\.test\\.ts$' },
      to: { path: '(^|/)kysely|^@db/db$|^backend/src/db/db(\\.ts)?$' },
    },
    {
      name: 'lib-imports-no-app',
      comment:
        'The shared library holds the API contract every app reads, so it depends on none of them.',
      severity: 'error',
      from: { path: '^lib/' },
      to: { path: '^(frontend|backend|load|infra)/' },
    },
    {
      name: 'load-stands-alone',
      comment:
        'The load harness is its own workspace: it reaches the app only over HTTP and the shared contract, and never imports app or infrastructure code.',
      severity: 'error',
      from: { path: '^load/src/' },
      to: { path: '^(frontend|backend|infra)/' },
    },
    {
      name: 'load-records-import-nothing-of-the-harness',
      comment:
        'Records define what a run stores, so every other part reads them and they depend on none of those parts.',
      severity: 'error',
      from: { path: '^load/src/records/' },
      to: { path: '^load/src/', pathNot: '^load/src/records/' },
    },
    {
      name: 'load-generator-reads-records-only',
      comment: 'The generator writes records and shares no code with what reads them back.',
      severity: 'error',
      from: { path: '^load/src/generator/' },
      to: { path: '^load/src/', pathNot: '^load/src/(generator|records)/' },
    },
    {
      name: 'load-rebuild-reads-records-and-criteria-only',
      comment:
        'Rebuild works from stored records alone and judges them by the criteria, so it never reaches into the generator, the archive or the home commands.',
      severity: 'error',
      from: { path: '^load/src/rebuild/' },
      to: { path: '^load/src/', pathNot: '^load/src/(rebuild|records|criteria)/' },
    },
    {
      name: 'load-rebuild-cannot-reach-aws',
      comment:
        'Rebuild works from the files of a run folder alone, so it may import no AWS client: it provably works after every stack is gone.',
      severity: 'error',
      from: { path: '^load/src/rebuild/' },
      to: {
        path: '(^|/)node_modules/(@aws-sdk|@smithy|aws-sdk|aws-cdk-lib|@aws-cdk)/|^(@aws-sdk|@smithy|aws-sdk|aws-cdk-lib|@aws-cdk)(/|$)',
      },
    },
    {
      name: 'load-criteria-reads-records-only',
      comment:
        'The criteria judge facts a run recorded, so they depend on nothing of the harness but the records.',
      severity: 'error',
      from: { path: '^load/src/criteria/' },
      to: { path: '^load/src/', pathNot: '^load/src/(criteria|records)/' },
    },
    {
      name: 'load-home-reads-records-run-archive-criteria-and-rebuild-only',
      comment:
        'The home run commands start the generator as a process, read its report through the records, have the run part watch and replace generators, seal the run with the archive and write its verdict with the rebuild, so they never import the generator.',
      severity: 'error',
      from: { path: '^load/src/home/' },
      to: {
        path: '^load/src/',
        pathNot: '^load/src/(home|run|archive|records|criteria|rebuild)/',
      },
    },
    {
      name: 'load-ecs-reads-records-run-archive-criteria-and-rebuild-only',
      comment:
        'The ECS command carries out an aws-prod run: it starts generators as tasks, has the run part watch and replace them, seals the run with the archive, and writes its verdict with the rebuild, judged by the limits the criteria give. It never imports the generator or the home commands.',
      severity: 'error',
      from: { path: '^load/src/ecs/' },
      to: {
        path: '^load/src/',
        pathNot: '^load/src/(ecs|run|archive|records|criteria|rebuild)/',
      },
    },
    {
      name: 'load-monitor-reads-nothing-of-the-harness',
      comment:
        'The live monitor works out its figures from what CloudWatch returns and highlights them by the pass lines of the signal catalogue, so it imports nothing of the harness.',
      severity: 'error',
      from: { path: '^load/src/monitor/' },
      to: { path: '^load/src/', pathNot: '^load/src/monitor/' },
    },
    {
      name: 'load-run-reads-records-only',
      comment:
        'The run part watches generators wherever they are launched and writes what happened as records, so it depends on nothing of the harness but the records, and none of the places generators run in.',
      severity: 'error',
      from: { path: '^load/src/run/' },
      to: { path: '^load/src/', pathNot: '^load/src/(run|records)/' },
    },
    {
      name: 'load-parts-meet-through-index',
      comment: 'Each part of the harness shows the others only what its index exports.',
      severity: 'error',
      from: { path: '^load/src/([^/]+)/', pathNot: '\\.test\\.ts$' },
      to: { path: '^load/src/[^/]+/', pathNot: ['^load/src/$1/', '^load/src/[^/]+/index\\.ts$'] },
    },
    {
      name: 'load-archive-reads-records-only',
      comment:
        "The archive collects what a run left and writes it in the records' form, so it shares no code with the generator that wrote them or the rebuild that reads them back.",
      severity: 'error',
      from: { path: '^load/src/archive/' },
      to: { path: '^load/src/', pathNot: '^load/src/(archive|records)/' },
    },
  ],
};
