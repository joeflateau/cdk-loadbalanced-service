import {
  aws_certificatemanager as acm,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_route53 as rt53,
  aws_route53_targets as rt53Targets,
  Duration as cdk_duration,
} from "aws-cdk-lib";
import { ELBv2 } from "aws-sdk";
import * as cdk from "constructs";
import { findPriorityOrFail } from "elb-rule-priority";

export class LoadBalancedService extends cdk.Construct {
  certificate: acm.DnsValidatedCertificate;
  cluster: ecs.ICluster;
  loadBalancer: elbv2.IApplicationLoadBalancer;
  hostedZone: rt53.IHostedZone;
  securityGroup: ec2.ISecurityGroup;

  constructor(
    scope: cdk.Construct,
    id: string,
    options: LoadBalancedServiceOptions
  ) {
    super(scope, id);

    const {
      targetGroupProps = {},
      createRoute53ARecord = true,
      serviceFactory,
      domainName,
      clusterName,
      containerSecurityGroupId: ecsSecurityGroupId,
      route53ZoneName,
      loadBalancer: {
        rulePriority,
        listenerArn: loadBalancerListenerArn,
        loadBalancerArn,
      },
    } = options;

    const securityGroup = (this.securityGroup =
      ec2.SecurityGroup.fromLookupById(
        this,
        `ECSSecurityGroup`,
        ecsSecurityGroupId
      ));

    const domainZone = (this.hostedZone = rt53.HostedZone.fromLookup(
      this,
      "ECSZone",
      {
        domainName:
          route53ZoneName ?? domainName.split(".").slice(-2).join("."),
      }
    ));

    const loadBalancer = (this.loadBalancer =
      elbv2.ApplicationLoadBalancer.fromLookup(this, "ECSLoadBalancer", {
        loadBalancerArn,
      }));

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
        securityGroups: [securityGroup],
      }
    ));

    const targetGroup = new elbv2.ApplicationTargetGroup(this, "TargetGroup", {
      vpc,
      protocol: elbv2.ApplicationProtocol.HTTP,
      deregistrationDelay: cdk_duration.seconds(15),
      stickinessCookieDuration: cdk_duration.days(1),
      ...targetGroupProps,
    });

    const cert = (this.certificate = new acm.DnsValidatedCertificate(
      this,
      "ACMCert",
      {
        domainName,
        hostedZone: domainZone,
      }
    ));

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

    if (createRoute53ARecord) {
      const recordSet = new rt53.ARecord(this, "ALBAlias", {
        recordName: domainName,
        zone: domainZone,
        target: rt53.RecordTarget.fromAlias(
          new rt53Targets.LoadBalancerTarget(loadBalancer)
        ),
      });
    }

    const service = serviceFactory(cluster, {
      securityGroup,
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
  containerSecurityGroupId: string;
  route53ZoneName?: string;
  loadBalancer: EcsLoadBalancerContext;
}
export interface LoadBalancedServiceDefaults {
  createRoute53ARecord?: boolean;
  targetGroupProps?: Partial<elbv2.ApplicationTargetGroupProps>;
}

export interface LoadBalancedServiceFactories {
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
  LoadBalancedServiceDefaults &
  LoadBalancedServiceFactories;
