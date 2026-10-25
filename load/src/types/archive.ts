/** A task that ran in a cluster, as ECS describes it. */
export type TaskInfo = {
  taskId: string;
  cluster: string;
  createdAt: string | null;
  startedAt: string | null;
  /** When ECS began stopping the task, which is when its container is told to stop; null when it has not. */
  stoppingAt: string | null;
  stoppedAt: string | null;
  stopCode: string | null;
  stoppedReason: string | null;
  exitCode: number | null;
  /** The capacity the task ran on, such as `FARGATE_SPOT`; null for plain On-Demand. */
  capacityProvider: string | null;
  /** What the task was started with beyond its definition. */
  environment: Readonly<Record<string, string>>;
};
