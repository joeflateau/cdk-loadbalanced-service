import * as acm from "@aws-cdk/aws-certificatemanager";
import * as ec2 from "@aws-cdk/aws-ec2";
import * as ecs from "@aws-cdk/aws-ecs";
import * as elbv2 from "@aws-cdk/aws-elasticloadbalancingv2";
import * as rt53 from "@aws-cdk/aws-route53";
import * as rt53Targets from "@aws-cdk/aws-route53-targets";
import * as cdk from "@aws-cdk/core";
import { ELBv2 } from "aws-sdk";
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
      clusterName,
      containerSecurityGroupIds: ecsSecurityGroupIds,
      route53ZoneName,
      loadBalancer: {
        rulePriority,
        listenerArn: loadBalancerListenerArn,
        loadBalancerArn,
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
      domainName: route53ZoneName ?? domainName.split(".").slice(-2).join("."),
    });

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

    const vpc = ec2.Vpc.fromLookup(this, "Vpc", {
      vpcId: options.vpcId,
    });

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

export async function getLoadBalancedServiceContext(
  options: {
    loadBalancerArn: string;
  } & Omit<LoadBalancedServiceContext, "loadBalancer">
): Promise<LoadBalancedServiceContext> {
  const context: LoadBalancedServiceContext = {
    ...options,

    loadBalancer: await getLoadBalancerContext(
      options.loadBalancerArn,
      options.domainName
    ),
  };

  return context;
}

async function getLoadBalancerContext(
  loadBalancerArn: string,
  hostname: string
): Promise<EcsLoadBalancerContext> {
  const elbv2 = new ELBv2();

  const listeners = (
    await elbv2
      .describeListeners({
        LoadBalancerArn: loadBalancerArn,
      })
      .promise()
  ).Listeners;

  const listener = listeners?.find((l) => l.Protocol === "HTTPS");

  const listenerArn = listener?.ListenerArn;

  if (listenerArn == null) {
    throw new Error(`could not find https listener`);
  }

  const context: EcsLoadBalancerContext = {
    loadBalancerArn,
    listenerArn,
    rulePriority: await findPriorityOrFail(listenerArn, hostname),
  };

  return context;
}

export type EcsLoadBalancerContext = {
  loadBalancerArn: string;
  listenerArn: string;
  rulePriority: number;
};

export interface LoadBalancedServiceContext {
  domainName: string;
  vpcId: string;
  clusterName: string;
  containerSecurityGroupIds: string[];
  route53ZoneName?: string;
  loadBalancer: EcsLoadBalancerContext;
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
