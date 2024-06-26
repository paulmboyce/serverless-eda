// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  HttpApi,
  HttpMethod,
  HttpRoute,
  HttpRouteKey,
  VpcLink
} from "@aws-cdk/aws-apigatewayv2-alpha";
import { HttpAlbIntegration } from "@aws-cdk/aws-apigatewayv2-integrations-alpha";
import { EventbridgeToSqs } from "@aws-solutions-constructs/aws-eventbridge-sqs";
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  aws_dynamodb as dynamodb,
  aws_ec2 as ec2,
  aws_ecr_assets as ecr_assets,
  aws_ecs as ecs,
  aws_ecs_patterns as ecs_patterns
} from 'aws-cdk-lib';
import { GraphWidget } from "aws-cdk-lib/aws-cloudwatch";
import { EventBus } from "aws-cdk-lib/aws-events";
import { RetentionDays } from "aws-cdk-lib/aws-logs";
import { Construct } from 'constructs';
import * as path from "path";
import { createGraphWidget, createMetric } from "../../../observability/cw-dashboard/infra/ClaimsProcessingCWDashboard";
import { FraudEvents } from "../../fraud/infra/fraud-events";

export enum SettlementEvents {
  SOURCE = "settlement.service",
  SETTLEMENT_FINALIZED = "Settlement.Finalized",
}

interface SettlementServiceProps {
  readonly bus: EventBus,
}

export class SettlementService extends Construct {
  public readonly table: dynamodb.Table;
  public readonly settlementMetricsWidget: GraphWidget;

  constructor(scope: Construct, id: string, props: SettlementServiceProps) {
    super(scope, id);

    const vpc = new ec2.Vpc(this, "vpc", {
      maxAzs: 3
    });

    const cluster = new ecs.Cluster(this, "cluster", {
      vpc: vpc
    });

    this.table = new dynamodb.Table(this, "SettlementTable", {
      partitionKey: { name: "Id", type: dynamodb.AttributeType.STRING, },
      readCapacity: 5,
      writeCapacity: 5,
      removalPolicy: RemovalPolicy.DESTROY, // NOT recommended for production code
    });

    const ebToSqsConstruct = new EventbridgeToSqs(this, 'eb-to-sqs-target', {
      existingEventBusInterface: props.bus,
      eventRuleProps: {
        eventPattern: {
          source: [FraudEvents.SOURCE],
          detail: {
            documentType: ["CAR"],
            fraudType: ["CLAIMS"]
          },
          detailType: [FraudEvents.FRAUD_NOT_DETECTED],
        }
      },
      queueProps: {
        queueName: `${Stack.of(this).stackName}-EBTarget`
      }
    });

    const queue = ebToSqsConstruct.sqsQueue;

    const asset = new ecr_assets.DockerImageAsset(this, "image", {
      directory: path.join(__dirname, "../app"),
    });

    const loadBalancedFargateService = new ecs_patterns.ApplicationLoadBalancedFargateService(
      this,
      "alb-fargate-service",
      {
        cluster: cluster,
        taskImageOptions: {
          image: ecs.ContainerImage.fromDockerImageAsset(asset),
          environment: {
            "SQS_ENDPOINT_URL": queue.queueUrl,
            "EVENTBUS_NAME": props.bus.eventBusName,
            "DYNAMODB_TABLE_NAME": this.table.tableName
          },
          containerPort: 8080,
          logDriver: new ecs.AwsLogDriver({
            streamPrefix: "settlement-service",
            mode: ecs.AwsLogDriverMode.NON_BLOCKING,
            logRetention: RetentionDays.ONE_DAY,
          })
        },
        memoryLimitMiB: 2048,
        cpu: 1024,
        publicLoadBalancer: false,
        desiredCount: 2,
        listenerPort: 8080
      });

    this.table.grantReadWriteData(loadBalancedFargateService.taskDefinition.taskRole);
    props.bus.grantPutEventsTo(loadBalancedFargateService.taskDefinition.taskRole);
    queue.grantConsumeMessages(loadBalancedFargateService.taskDefinition.taskRole);

    loadBalancedFargateService.targetGroup.configureHealthCheck({
      path: "/actuator/health"
    });

    const scaling = loadBalancedFargateService.service.autoScaleTaskCount({ maxCapacity: 6, minCapacity: 2 });
    scaling.scaleOnCpuUtilization("CpuScaling", {
      targetUtilizationPercent: 50,
      scaleInCooldown: Duration.seconds(60),
      scaleOutCooldown: Duration.seconds(60)
    });

    const listener = loadBalancedFargateService.loadBalancer.listeners[0];    
    const httpApi = new HttpApi(this, "settlement-http-api", {});
    const vpcLink = new VpcLink(this, "settlement-vpc-link", {
      vpc,
    });
    
    const integration = new HttpAlbIntegration(
      "http-alb-integration",
      listener,
      {
        method: HttpMethod.POST,
        vpcLink,
      }
    );
    
    new HttpRoute(this, "http-route", {
      httpApi,
      routeKey: HttpRouteKey.with("/settlement", HttpMethod.POST),
      integration,
    });

    new CfnOutput(this, "HttpApiEndpoint", { value: `${httpApi.url}settlement` });

    this.settlementMetricsWidget = createGraphWidget("Settlement Summary", [
      createMetric(
        "Settlement.Finalized",
        "settlement.service",
        "Settlement Finalized"
      )
    ]);
  }
}
