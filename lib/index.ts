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
      vpc: { vpcId },
      ecs: { clusterName, securityGroupId: ecsSecurityGroupId },
      route53: { hostedZoneId, zoneName },
      ec2: {
        loadBalancer: {
          rulePriority,
          securityGroupId: loadBalancerSecurityGroupId,
          loadBalancerArn,
          loadBalancerDnsName,
          loadBalancerCanonicalHostedZoneId,
          loadBalancerListenerArn,
        },
      },
    } = options;

    const vpc = ec2.Vpc.fromLookup(this, "ECSVPC", {
      vpcId,
    });

    const securityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      "ECSSecurityGroup",
      ecsSecurityGroupId
    );

    const cluster = (this.cluster = ecs.Cluster.fromClusterAttributes(
      this,
      "ECSCluster",
      {
        vpc,
        clusterName,
        securityGroups: [securityGroup],
      }
    ));

    const domainZone = rt53.HostedZone.fromHostedZoneAttributes(
      this,
      "ECSZone",
      {
        hostedZoneId,
        zoneName,
      }
    );

    const loadBalancer =
      elbv2.ApplicationLoadBalancer.fromApplicationLoadBalancerAttributes(
        this,
        "ECSLoadBalancer",
        {
          loadBalancerArn,
          securityGroupId: loadBalancerSecurityGroupId,
          loadBalancerDnsName,
          loadBalancerCanonicalHostedZoneId,
        }
      );

    const listener =
      elbv2.ApplicationListener.fromApplicationListenerAttributes(
        this,
        "ECSListener",
        {
          securityGroup,
          listenerArn: loadBalancerListenerArn,
        }
      );

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
      securityGroup,
      vpc,
      targetGroup,
      hostedZone: domainZone,
    });

    targetGroup.addTarget(service);
  }
}

export async function getContext(
  options: {
    ec2: { loadBalancerListenerArn: string };
  } & Omit<LoadBalancedServiceContext, "ec2">
): Promise<LoadBalancedServiceContext> {
  const context: LoadBalancedServiceContext = {
    ...options,
    ec2: {
      loadBalancer: await getLoadBalancerContext(
        options.ec2.loadBalancerListenerArn,
        options.domainName
      ),
    },
  };

  return context;
}

export async function getLoadBalancerContext(
  listenerArn: string,
  hostname: string
): Promise<EcsLoadBalancerContext> {
  const elbv2 = new ELBv2();

  const [listener] = (
    await elbv2
      .describeListeners({
        ListenerArns: [listenerArn],
      })
      .promise()
  ).Listeners!;

  if (listener == null) {
    throw new Error(`did not find listener with arn: ${listenerArn}`);
  }

  const [loadbalancer] = (
    await elbv2
      .describeLoadBalancers({
        LoadBalancerArns: [listener.LoadBalancerArn!],
      })
      .promise()
  ).LoadBalancers!;

  if (loadbalancer == null) {
    throw new Error(
      `did not find load balancer with arn: ${listener.LoadBalancerArn}`
    );
  }

  const context: EcsLoadBalancerContext = {
    loadBalancerArn: listener.LoadBalancerArn!,
    loadBalancerListenerArn: listener.ListenerArn!,
    loadBalancerCanonicalHostedZoneId: loadbalancer.CanonicalHostedZoneId!,
    loadBalancerDnsName: loadbalancer.DNSName!,
    securityGroupId: loadbalancer.SecurityGroups![0],
    rulePriority: await findPriorityOrFail(listenerArn, hostname),
  };

  return context;
}

export type EcsLoadBalancerContext = {
  securityGroupId: string;
  rulePriority: number;
  loadBalancerArn: string;
  loadBalancerDnsName: string;
  loadBalancerCanonicalHostedZoneId: string;
  loadBalancerListenerArn: string;
};

export interface LoadBalancedServiceContext {
  domainName: string;
  vpc: { vpcId: string };
  ecs: {
    clusterName: string;
    securityGroupId: string;
  };
  route53: {
    hostedZoneId: string;
    zoneName: string;
  };
  ec2: {
    loadBalancer: EcsLoadBalancerContext;
  };
}
export interface LoadBalancedServiceFactories {
  targetGroupFactory: (vpc: ec2.IVpc) => elbv2.ApplicationTargetGroup;
  serviceFactory: (
    cluster: ecs.ICluster,
    extras: {
      securityGroup: ec2.ISecurityGroup;
      vpc: ec2.IVpc;
      targetGroup: elbv2.ApplicationTargetGroup;
      hostedZone: rt53.IHostedZone;
    }
  ) => ecs.Ec2Service;
}

export type LoadBalancedServiceOptions = LoadBalancedServiceContext &
  LoadBalancedServiceFactories;
