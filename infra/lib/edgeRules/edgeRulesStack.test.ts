import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { EDGE_REGION, EDGE_RULES_PARAMETERS, LOAD_KEY_HEADER } from '../../config/names.ts';
import { EdgeRulesStack, SIGN_INS_PER_ADDRESS_PER_MINUTE } from './edgeRulesStack.ts';

const template = Template.fromStack(
  new EdgeRulesStack(new App(), 'EdgeRules', {
    env: { account: '123456789012', region: EDGE_REGION },
  }),
);

const webAcl = () => {
  const [acl] = Object.values(template.findResources('AWS::WAFv2::WebACL'));
  return acl?.Properties;
};

const carriesLoadKey = {
  ByteMatchStatement: {
    FieldToMatch: { SingleHeader: { Name: LOAD_KEY_HEADER } },
    PositionalConstraint: 'EXACTLY',
    SearchString: { Ref: EDGE_RULES_PARAMETERS.runKey },
    TextTransformations: [{ Priority: 0, Type: 'NONE' }],
  },
};

describe('the edge rules', () => {
  it('turn away everyone but the operator’s addresses and requests carrying the load key', () => {
    const acl = webAcl();
    const allow = acl.Rules.find((rule: { Action: object }) => 'Allow' in rule.Action);

    assert.equal(acl.Scope, 'CLOUDFRONT');
    assert.deepEqual(acl.DefaultAction, { Block: {} });
    assert.deepEqual(allow.Statement.OrStatement.Statements[1], carriesLoadKey);
    template.hasResourceProperties('AWS::WAFv2::IPSet', {
      Scope: 'CLOUDFRONT',
      IPAddressVersion: 'IPV4',
      Addresses: { Ref: EDGE_RULES_PARAMETERS.operatorAddresses },
    });
  });

  it('limit sign-ins per address before anything is let through, counting none that carry the load key', () => {
    const acl = webAcl();
    const [first] = [...acl.Rules].sort(
      (a: { Priority: number }, b: { Priority: number }) => a.Priority - b.Priority,
    );
    const limit = first.Statement.RateBasedStatement;

    assert.deepEqual(first.Action, { Block: {} });
    assert.equal(limit.AggregateKeyType, 'IP');
    assert.equal(limit.EvaluationWindowSec, 60);
    assert.equal(limit.Limit, SIGN_INS_PER_ADDRESS_PER_MINUTE);
    assert.deepEqual(limit.ScopeDownStatement.AndStatement.Statements[1], {
      NotStatement: { Statement: carriesLoadKey },
    });
    assert.equal(
      limit.ScopeDownStatement.AndStatement.Statements[0].ByteMatchStatement.SearchString,
      '/api/auth/',
    );
  });

  it('hide the run key among the stack’s parameters', () => {
    template.hasParameter(EDGE_RULES_PARAMETERS.runKey, { NoEcho: true });
  });
});
