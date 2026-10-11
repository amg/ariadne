import {
  CloudFormationClient,
  DeleteStackCommand,
  DescribeStacksCommand,
  type Stack,
} from '@aws-sdk/client-cloudformation';

/** A stack the safety net watches, and how long it may live after it was created. */
export type StackLimit = { stackName: string; maxAgeMinutes: number };

const cloudFormation = new CloudFormationClient({});

/** Deletes every watched stack that has outlived its limit; stacks already gone are skipped. */
export async function handler(): Promise<void> {
  // Written by the construct that deploys this function, from typed values.
  const limits = JSON.parse(process.env.STACK_LIMITS ?? '[]') as StackLimit[];
  for (const limit of limits) {
    await deleteIfExpired(limit, new Date());
  }
}

async function deleteIfExpired(limit: StackLimit, now: Date): Promise<void> {
  const stack = await liveStackOrNull(limit.stackName);
  if (stack?.CreationTime === undefined) return;

  const ageMinutes = (now.getTime() - stack.CreationTime.getTime()) / 60_000;
  if (ageMinutes < limit.maxAgeMinutes) return;

  console.log(`Deleting ${limit.stackName}: ${Math.round(ageMinutes)} minutes old`);
  await cloudFormation.send(new DeleteStackCommand({ StackName: limit.stackName }));
}

async function liveStackOrNull(stackName: string): Promise<Stack | null> {
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
