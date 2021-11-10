import * as acm from "@aws-cdk/aws-certificatemanager";
import * as ec2 from "@aws-cdk/aws-ec2";
import * as ecs from "@aws-cdk/aws-ecs";
import * as elbv2 from "@aws-cdk/aws-elasticloadbalancingv2";
import * as rt53 from "@aws-cdk/aws-route53";
import * as rt53Targets from "@aws-cdk/aws-route53-targets";
import * as cdk from "@aws-cdk/core";
import { findPriorityOrFail } from "elb-rule-priority";

export class LoadBalancedService extends cdk.Construct {
  cluster: ecs.ICluster;

  constructor(
    scope: cdk.Construct,
    id: string,
    options: LoadBalancedServiceOptions
  ) {
    super(scope, id);

    const {
      targetGroupFactory,
      serviceFactory,
      domainName,
      ecs: { clusterName, securityGroupIds: ecsSecurityGroupIds },
      route53ZoneName,
      ec2: {
        loadBalancer: { rulePriority, listenerArn: loadBalancerListenerArn },
      },
    } = options;

    const securityGroups = ecsSecurityGroupIds.map((securityGroupId, i) =>
      ec2.SecurityGroup.fromLookup(
        this,
        `ECSSecurityGroup${i}`,
        securityGroupId
      )
    );

    const domainZone = rt53.HostedZone.fromLookup(this, "ECSZone", {
      domainName: route53ZoneName,
    });

    const loadBalancerArn = listenerArnToLoadBalancerArn(
      loadBalancerListenerArn
    );

    const loadBalancer = elbv2.ApplicationLoadBalancer.fromLookup(
      this,
      "ECSLoadBalancer",
      {
        loadBalancerArn,
      }
    );

    const listener = elbv2.ApplicationListener.fromLookup(this, "ECSListener", {
      listenerArn: loadBalancerListenerArn,
    });

    const vpc = loadBalancer.vpc!;

    const cluster = (this.cluster = ecs.Cluster.fromClusterAttributes(
      this,
      "ECSCluster",
      {
        vpc,
        clusterName,
        securityGroups,
      }
    ));

    const targetGroup = targetGroupFactory(vpc);

    const cert = new acm.DnsValidatedCertificate(this, "ACMCert", {
      domainName,
      hostedZone: domainZone,
    });

    const listenerRule = new elbv2.ApplicationListenerRule(
      this,
      "ALBListenerRule",
      {
        listener,
        priority: rulePriority,
        conditions: [elbv2.ListenerCondition.hostHeaders([domainName])],
        action: elbv2.ListenerAction.forward([targetGroup]),
      }
    );

    const listenerCert = new elbv2.ApplicationListenerCertificate(
      this,
      "ALBListenerCert",
      {
        listener,
        certificates: [cert],
      }
    );

    const recordSet = new rt53.ARecord(this, "ALBAlias", {
      recordName: domainName,
      zone: domainZone,
      target: rt53.RecordTarget.fromAlias(
        new rt53Targets.LoadBalancerTarget(loadBalancer)
      ),
    });

    const service = serviceFactory(cluster, {
      securityGroups,
      vpc,
      targetGroup,
      hostedZone: domainZone,
    });

    targetGroup.addTarget(service);
  }
}

function listenerArnToLoadBalancerArn(loadBalancerListenerArn: string) {
  return loadBalancerListenerArn.split("/").slice(0, -1).join("/");
}

export async function getContext(
  options: {
    loadBalancer: {
      listenerArn: string;
    };
    route53ZoneId: string;
  } & Omit<LoadBalancedServiceContext, "ec2">
): Promise<LoadBalancedServiceContext> {
  const context: LoadBalancedServiceContext = {
    ...options,
    ec2: {
      loadBalancer: await getLoadBalancerContext(
        options.loadBalancer.listenerArn,
        options.domainName
      ),
    },
  };

  return context;
}

async function getLoadBalancerContext(
  listenerArn: string,
  hostname: string
): Promise<EcsLoadBalancerContext> {
  const context: EcsLoadBalancerContext = {
    listenerArn,
    rulePriority: await findPriorityOrFail(listenerArn, hostname),
  };

  return context;
}

export type EcsLoadBalancerContext = {
  listenerArn: string;
  rulePriority: number;
};

export type EcsClusterContext = {
  clusterName: string;
  securityGroupIds: string[];
};

export interface LoadBalancedServiceContext {
  domainName: string;
  vpcId: string;
  ecs: EcsClusterContext;
  route53ZoneName: string;
  ec2: {
    loadBalancer: EcsLoadBalancerContext;
  };
}
export interface LoadBalancedServiceFactories {
  targetGroupFactory: (vpc: ec2.IVpc) => elbv2.ApplicationTargetGroup;
  serviceFactory: (
    cluster: ecs.ICluster,
    extras: {
      securityGroups: ec2.ISecurityGroup[];
      vpc: ec2.IVpc;
      targetGroup: elbv2.ApplicationTargetGroup;
      hostedZone: rt53.IHostedZone;
    }
  ) => ecs.Ec2Service;
}

export type LoadBalancedServiceOptions = LoadBalancedServiceContext &
  LoadBalancedServiceFactories;
