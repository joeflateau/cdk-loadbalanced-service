import * as cdk from '@aws-cdk/core';

export interface CdkLoadbalancedServiceProps {
  // Define construct properties here
}

export class CdkLoadbalancedService extends cdk.Construct {

  constructor(scope: cdk.Construct, id: string, props: CdkLoadbalancedServiceProps = {}) {
    super(scope, id);

    // Define construct contents here
  }
}
