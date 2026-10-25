import type { Judgement } from '../../types/criteria.ts';
import { MINUTE_MS } from '../moments.ts';
import type { MinuteTable, RunFacts } from '../types.ts';
import { type Section, builderOf, withoutEmpty } from './builder.ts';
import {
  hostSection,
  insightsSection,
  markersSection,
  targetGroupsSection,
} from './sections/beyondTheDashboard.ts';
import {
  balancerSection,
  cacheSection,
  connectionsSection,
  databaseSection,
  diskSection,
  fargateSection,
  pushStreamsSection,
  servicesSection,
  tasksSection,
} from './sections/infrastructure.ts';
import {
  appSection,
  copiesSection,
  gateSection,
  generatorsSection,
  usersSection,
} from './sections/whatUsersAndAppSee.ts';

type Inputs = {
  facts: RunFacts;
  table: MinuteTable;
  judgements: readonly Judgement[];
};

/**
 * The sections of a report. One section stands for each row of the live
 * dashboard, in the dashboard's order. What the run holds beyond the
 * dashboard follows: the push streams that ended early, how loaded each
 * copy of the backend is, the home machine, Performance Insights, the
 * target groups and what the run wrote to the database. The list of
 * moments the charts mark comes last. A line with no value, a chart left with no line
 * and a section left with nothing are left out.
 */
export function reportSections({ facts, table, judgements }: Inputs): Section[] {
  const start = table.minutes[0] ?? 0;
  const end = (table.minutes.at(-1) ?? start) + MINUTE_MS;
  const markers = facts.markers.filter((marker) => {
    const at = Date.parse(marker.at);
    return table.minutes.length > 0 && at >= start && at <= end;
  });
  const { insights, requests } = facts.summary;
  const failures = requests.failures;
  const builder = builderOf({
    facts,
    table,
    judgements,
    markers: markers.map((marker, index) => ({ at: Date.parse(marker.at), number: index + 1 })),
  });
  return withoutEmpty([
    usersSection(builder, failures),
    generatorsSection(builder),
    appSection(builder),
    gateSection(builder),
    tasksSection(builder),
    fargateSection(builder),
    balancerSection(builder),
    connectionsSection(builder),
    servicesSection(builder),
    databaseSection(builder),
    diskSection(builder),
    cacheSection(builder),
    pushStreamsSection(builder),
    copiesSection(builder),
    hostSection(builder),
    ...(insights === null ? [] : [insightsSection(builder, insights)]),
    targetGroupsSection(builder),
    ...(markers.length === 0 ? [] : [markersSection(markers)]),
  ]);
}
