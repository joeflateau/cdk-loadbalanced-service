# cdk-loadbalanced-ecs-service

This CDK Construct allows you to integrate a new ECS Service into an existing AWS Application Loadbalancer, AWS ECS Cluster and AWS Route53 Hosted Zone.

## Usage

In cdk.ts

```ts
import {
  getLoadBalancedServiceContext,
  LoadBalancedServiceContext,
  LoadBalancedService,
} from "cdk-loadbalanced-ecs-service";

async function main() {
  //   this will load all the context needed to integrate this new service into existing infrastructure including picking a new ALB Rule Priority
  const context = await getLoadBalancedServiceContext({
    domainName: "myhostname.com",
    vpcId: "vpc-abc123abc123abc123",
    loadBalancerArn:
      "arn:aws:elasticloadbalancing:us-east-1:132456789:loadbalancer/app/my-load-balancer/132456789",
    clusterName: "my-ecs-cluster",
    containerSecurityGroupId: "sg-abc123abc123",
  });

  new MyStack(app, "Stack", { context });
}

main();

class MyStack extends Construct {
  constructor(
    scope: Construct,
    id: string,
    options: { context: LoadBalancedServiceContext }
  ) {
    super(scope, id);

    const lbService = new LoadBalancedService(this, "LBService", {
      // spread context into LoadBalancedService props
      ...options.context,
      targetGroupProps: { vpc, healthCheck: { path: "/healthcheck" } },
      serviceFactory: (cluster) => {
        const taskDefinition = new ecs.Ec2TaskDefinition(
          this,
          "TaskDefinition",
          {
            taskRole,
            executionRole,
          }
        );

        const container = taskDefinition.addContainer("Api", {
          image: ecs.ContainerImage.fromDockerImageAsset(
            new ecrassets.DockerImageAsset(this, "ImageAsset", {
              directory: joinPath(__dirname, "../../../.."),
              file: "./apps/my-app/Dockerfile",
            })
          ),
          memoryLimitMiB: 1024,
          essential: true,
          command: ["serve"],
        });

        container.addPortMappings({
          containerPort: "8080",
        });

        const ecsService = new ecs.Ec2Service(this, "EC2Service", {
          cluster,
          taskDefinition,
        });

        return apiEcsService;
      },
    });
  }
}
```
