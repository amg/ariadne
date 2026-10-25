import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { isInCatalogue, searchedMetricsIn } from '../../../lib/metrics/searches.ts';
import { LoadDashboard } from './loadDashboard.ts';

function dashboardBody() {
  const stack = new Stack();
  new LoadDashboard(stack, 'Dashboard');
  const [dashboard] = Object.values(
    Template.fromStack(stack).findResources('AWS::CloudWatch::Dashboard'),
  );
  return JSON.stringify(dashboard?.Properties.DashboardBody);
}

describe('the load dashboard', () => {
  it('searches only for signals of the catalogue, at the statistic it gives them', () => {
    const searched = searchedMetricsIn(dashboardBody());

    assert.ok(searched.length > 40);
    assert.deepEqual(
      searched.filter((metric) => !isInCatalogue(metric)),
      [],
    );
  });
});
