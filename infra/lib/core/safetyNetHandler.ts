import {
  CloudFormationClient,
  DeleteStackCommand,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';

/** A stack the safety net watches, the region it is in, and how long it may live after it was created. */
export type StackLimit = { stackName: string; region: string; maxAgeMinutes: number };

/**
 * Deletes every watched stack that has outlived its limit; stacks already
 * gone are skipped. A stack whose deletion failed is asked to delete again.
 */
export async function handler() {
  // Written by the construct that deploys this function, from typed values.
  const limits = JSON.parse(process.env.STACK_LIMITS ?? '[]') as StackLimit[];
  for (const limit of limits) {
    await deleteIfExpired(limit, new Date());
  }
}

async function deleteIfExpired(limit: StackLimit, now: Date) {
  const cloudFormation = new CloudFormationClient({ region: limit.region });
  const stack = await liveStackOrNull(cloudFormation, limit.stackName);
  if (stack?.CreationTime === undefined) return;

  const ageMinutes = (now.getTime() - stack.CreationTime.getTime()) / 60_000;
  if (ageMinutes < limit.maxAgeMinutes) return;

  console.log(`Deleting ${limit.stackName}: ${Math.round(ageMinutes)} minutes old`);
  await cloudFormation.send(new DeleteStackCommand({ StackName: limit.stackName }));
}

async function liveStackOrNull(cloudFormation: CloudFormationClient, stackName: string) {
  try {
    const { Stacks } = await cloudFormation.send(
      new DescribeStacksCommand({ StackName: stackName }),
    );
    const stack = Stacks?.[0];
    if (stack === undefined || stack.StackStatus === 'DELETE_IN_PROGRESS') return null;
    return stack;
  } catch (error) {
    if (error instanceof Error && error.message.includes('does not exist')) return null;
    throw error;
  }
}
