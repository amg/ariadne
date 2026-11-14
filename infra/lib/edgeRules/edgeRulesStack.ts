import { CfnOutput, CfnParameter, Stack, type StackProps } from 'aws-cdk-lib';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';
import { EDGE_RULES_PARAMETERS, LOAD_KEY_HEADER, OUTPUTS } from '../../config/names.ts';
import { markLifetime } from '../lifetime.ts';
import { EDGE_RULE_COUNT } from '../worstCase.ts';

/** The most sign-in and refresh requests one address may make in a minute. */
export const SIGN_INS_PER_ADDRESS_PER_MINUTE = 20;

/**
 * Who may reach aws-prod at the edge. Only the operator's addresses and
 * requests carrying the raise's load key get in, and everyone else is
 * turned away. Past that, one address may sign in only so often, though
 * requests with the load key are not counted, since each generator signs in
 * thousands of users from one address. The web ACL bills by the hour, so it
 * is raised and removed with the app. It lives in the edge's region, the
 * only one CloudFront takes a web ACL from.
 */
export class EdgeRulesStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    markLifetime(this, 'app');

    const operatorAddresses = new CfnParameter(this, EDGE_RULES_PARAMETERS.operatorAddresses, {
      type: 'CommaDelimitedList',
      description: 'The IPv4 addresses the operator browses from, each as a /32',
    });
    const runKey = new CfnParameter(this, EDGE_RULES_PARAMETERS.runKey, {
      type: 'String',
      noEcho: true,
      description: 'The raise’s load key, which the generators send in the load key header',
    });

    const operator = new wafv2.CfnIPSet(this, 'Operator', {
      scope: 'CLOUDFRONT',
      ipAddressVersion: 'IPV4',
      addresses: operatorAddresses.valueAsList,
    });
    const carriesLoadKey = {
      byteMatchStatement: {
        fieldToMatch: { singleHeader: { Name: LOAD_KEY_HEADER } },
        positionalConstraint: 'EXACTLY',
        searchString: runKey.valueAsString,
        textTransformations: [{ priority: 0, type: 'NONE' }],
      },
    };

    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      scope: 'CLOUDFRONT',
      defaultAction: { block: {} },
      visibilityConfig: visibility('EdgeRules'),
      rules: [
        {
          name: 'SignInsPerAddress',
          priority: 0,
          action: { block: {} },
          visibilityConfig: visibility('SignInsPerAddress'),
          statement: {
            rateBasedStatement: {
              aggregateKeyType: 'IP',
              evaluationWindowSec: 60,
              limit: SIGN_INS_PER_ADDRESS_PER_MINUTE,
              scopeDownStatement: {
                andStatement: {
                  statements: [
                    {
                      byteMatchStatement: {
                        fieldToMatch: { uriPath: {} },
                        positionalConstraint: 'STARTS_WITH',
                        searchString: '/api/auth/',
                        textTransformations: [{ priority: 0, type: 'NONE' }],
                      },
                    },
                    { notStatement: { statement: carriesLoadKey } },
                  ],
                },
              },
            },
          },
        },
        {
          name: 'OperatorAndLoadOnly',
          priority: 1,
          action: { allow: {} },
          visibilityConfig: visibility('OperatorAndLoadOnly'),
          statement: {
            orStatement: {
              statements: [{ ipSetReferenceStatement: { arn: operator.attrArn } }, carriesLoadKey],
            },
          },
        },
      ],
    });

    if (!Array.isArray(webAcl.rules) || webAcl.rules.length !== EDGE_RULE_COUNT) {
      throw new Error('EDGE_RULE_COUNT is out of step with the rules the web ACL holds');
    }
    new CfnOutput(this, OUTPUTS.webAclArn, { value: webAcl.attrArn });
  }
}

/** Counts the requests a rule matched, and keeps a sample of them for the console. */
function visibility(metricName: string) {
  return { cloudWatchMetricsEnabled: true, metricName, sampledRequestsEnabled: true };
}
