import { Tags } from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';
import { LIFETIME_TAG, type Lifetime, PROJECT, PROJECT_TAG } from '../config/names.ts';

/**
 * Tags everything under `scope` with its lifetime, so a sweep can find any
 * resource that outlived its teardown.
 */
export function markLifetime(scope: IConstruct, lifetime: Lifetime) {
  Tags.of(scope).add(LIFETIME_TAG, lifetime);
  Tags.of(scope).add(PROJECT_TAG, PROJECT);
}
