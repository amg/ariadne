import * as ecs from 'aws-cdk-lib/aws-ecs';
import { Construct } from 'constructs';
import {
  AUTH_CORE_TAG,
  DATABASE,
  HOSTNAME,
  INTERNAL_DOMAIN,
  INTERNAL_NAMES,
  PORTS,
} from '../../config/names.ts';
import type { Step } from '../../config/steps.ts';
import type { CoreResources } from '../types/core.ts';
import { AppService } from './appService.ts';
import type { Cache } from './cache.ts';
import type { Database } from './database.ts';

type ServicesProps = {
  cluster: ecs.ICluster;
  step: Step;
  imageTag: string;
  core: CoreResources;
  database: Database;
  cache: Cache;
};

/**
 * The five services: the backend API, its worker, the auth core, mock
 * inference, and nginx serving the built frontend. Who may connect to whom
 * is declared here, next to the services themselves.
 */
export class Services extends Construct {
  readonly api: AppService;
  readonly web: AppService;
  readonly auth: AppService;
  readonly mock: AppService;
  /** Runs the queue; shares Valkey and the database with the API. */
  readonly worker: AppService;

  constructor(scope: Construct, id: string, props: ServicesProps) {
    super(scope, id);
    const { step, database, cache } = props;
    const image = (name: 'backend' | 'web') =>
      ecs.ContainerImage.fromEcrRepository(props.core.repositories[name], props.imageTag);

    this.auth = new AppService(this, 'Auth', {
      cluster: props.cluster,
      image: authCoreImage(props.core),
      size: step.services.auth,
      deploy: step.deploy,
      port: PORTS.auth,
      discoveryName: INTERNAL_NAMES.auth,
      environment: {
        POSTGRESQL_HOST: database.instance.dbInstanceEndpointAddress,
        POSTGRESQL_PORT: String(PORTS.postgres),
        POSTGRESQL_DATABASE_NAME: DATABASE.name,
        POSTGRESQL_TABLE_SCHEMA: 'auth',
      },
      secrets: {
        POSTGRESQL_USER: ecs.Secret.fromSecretsManager(database.secret, 'username'),
        POSTGRESQL_PASSWORD: ecs.Secret.fromSecretsManager(database.secret, 'password'),
        API_KEYS: ecs.Secret.fromSecretsManager(props.core.authApiKey),
      },
    });

    this.mock = new AppService(this, 'Mock', {
      cluster: props.cluster,
      image: image('backend'),
      size: step.services.mock,
      deploy: step.deploy,
      port: PORTS.mock,
      discoveryName: INTERNAL_NAMES.mock,
      command: ['npx', 'tsx', 'mock/server.ts'],
      environment: { PORT: String(PORTS.mock), HOST: '0.0.0.0' },
    });

    const backend = backendSettings(props);

    this.api = new AppService(this, 'Api', {
      cluster: props.cluster,
      image: image('backend'),
      size: step.services.api,
      deploy: step.deploy,
      port: PORTS.api,
      // Migrations hold a lock, so tasks starting together apply them once.
      command: ['sh', '-c', 'npm run migrate && exec node dist/server.aws.js'],
      environment: { ...backend.environment, PROCESS_ROLE: 'api' },
      secrets: backend.secrets,
      systemControls: [PUSH_STREAM_GIVE_UP],
    });

    this.worker = new AppService(this, 'Worker', {
      cluster: props.cluster,
      image: image('backend'),
      size: step.services.worker,
      deploy: step.deploy,
      // No port: worker processes queue jobs, doesn't accept HTTP connections
      command: ['node', 'dist/worker.js'],
      environment: {
        ...backend.environment,
        PROCESS_ROLE: 'worker',
        ...jobConcurrencySetting(step.services.worker.jobConcurrency),
      },
      secrets: backend.secrets,
    });

    this.web = new AppService(this, 'Web', {
      cluster: props.cluster,
      image: image('web'),
      size: step.services.web,
      deploy: step.deploy,
      port: PORTS.web,
    });

    for (const backendService of [this.api, this.worker]) {
      this.auth.acceptFrom(backendService.service);
      this.mock.acceptFrom(backendService.service);
      database.connections.allowDefaultPortFrom(backendService.service);
      cache.connections.allowDefaultPortFrom(backendService.service);
    }
    database.connections.allowDefaultPortFrom(this.auth.service);
  }
}

function jobConcurrencySetting(jobConcurrency: number | undefined): Record<string, string> {
  return jobConcurrency === undefined ? {} : { WORKER_JOB_CONCURRENCY: String(jobConcurrency) };
}

function authCoreImage(core: CoreResources): ecs.ContainerImage {
  return ecs.ContainerImage.fromEcrRepository(core.repositories.auth, AUTH_CORE_TAG);
}

/**
 * The API gives up on a connection whose far end has stopped acknowledging
 * what it sends after about 100 s, instead of the platform's default of
 * about 15 minutes. A push stream to a tab that is gone then closes, and
 * stops being counted as open.
 */
const PUSH_STREAM_GIVE_UP: ecs.SystemControl = {
  namespace: 'net.ipv4.tcp_retries2',
  value: '8',
};

/** What the API and the worker both read: the same backend, configured once. */
function backendSettings(props: ServicesProps): {
  environment: Record<string, string>;
  secrets: Record<string, ecs.Secret>;
} {
  const { step, database, cache } = props;
  return {
    environment: {
      NODE_ENV: 'production',
      PORT: String(PORTS.api),
      HOST: '0.0.0.0',
      DB_HOST: database.instance.dbInstanceEndpointAddress,
      DB_PORT: String(PORTS.postgres),
      DB_NAME: DATABASE.name,
      MOCK_AI_BASE_URL: `http://${INTERNAL_NAMES.mock}.${INTERNAL_DOMAIN}:${PORTS.mock}/v1`,
      SUPERTOKENS_CONNECTION_URI: `http://${INTERNAL_NAMES.auth}.${INTERNAL_DOMAIN}:${PORTS.auth}`,
      CORS_ORIGINS: `https://${HOSTNAME}`,
      AUTH_SIGNUP_ENABLED: String(step.signupOpen),
      // Keeps the app's per-address sign-in limit off, which would throttle
      // the load generators. The edge rule itself is off on the Free plan;
      // the allow-list keeps everyone else out (cloudflare/app edge_rate_limit).
      AUTH_RATE_LIMIT_AT_EDGE: 'true',
      VALKEY_URL: cache.url,
      EXCHANGE_STALENESS_MS: '240000',
      GATE_WAIT_MS: '10000',
      HANDOVER_WAIT_MS: '10000',
      THREAD_ANALYSIS_MODE: 'heuristic',
      // Each app record also publishes its figures as metrics.
      PUBLISH_METRICS: 'true',
      // Often enough for a queue-wait signal with a 250 ms target.
      STATE_LOG_INTERVAL_SECONDS: '5',
      FEATURE_MEMORY: 'true',
      // High enough never to refuse under mocked inference, while keeping
      // the budget check on the measured path.
      DAILY_SPEND_BUDGET_USD: '1000000',
    },
    secrets: {
      DB_USER: ecs.Secret.fromSecretsManager(database.secret, 'username'),
      DB_PASSWORD: ecs.Secret.fromSecretsManager(database.secret, 'password'),
      SUPERTOKENS_API_KEY: ecs.Secret.fromSecretsManager(props.core.authApiKey),
    },
  };
}
