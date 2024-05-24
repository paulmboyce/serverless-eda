// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import { EventBus, EventField, IRuleTarget, Rule, RuleTargetInput, RuleTargetInputProperties } from "aws-cdk-lib/aws-events";
import { CloudWatchLogGroup, LogGroupTargetInput, SqsQueue } from "aws-cdk-lib/aws-events-targets";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import { CleanupService } from "./cleanup/infra/cleanup-service";
import { ClaimsProcessingCWDashboard } from "./observability/cw-dashboard/infra/ClaimsProcessingCWDashboard";
import createMetricsQueueWithLambdaSubscription from "./observability/cw-dashboard/infra/createMetric";
import { ClaimsEvents } from "./services/claims/infra/claims-events";
import { ClaimsService } from "./services/claims/infra/claims-service";
import { CustomerEvents } from "./services/customer/infra/customer-events";
import { CustomerService } from "./services/customer/infra/customer-service";
import { DocumentsEvents } from "./services/documents/infra/documents-events";
import { DocumentService } from "./services/documents/infra/documents-service";
import { FraudEvents } from "./services/fraud/infra/fraud-events";
import { FraudService } from "./services/fraud/infra/fraud-service";
import { NotificationsService } from "./services/notifications/infra/notifications-service";
// import { SettlementEvents, SettlementService } from "./services/settlement/infra/settlement-service";
import { CfnDiscoverer } from "aws-cdk-lib/aws-eventschemas";
import { TargetTrackingScalingPolicy } from "aws-cdk-lib/aws-applicationautoscaling";
// import { VendorEvents, VendorService } from "./services/vendor/infra/vendor-service";

export class ClaimsProcessingStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const stackName = Stack.of(this).stackName;
    const region = Stack.of(this).region;

    const bus = new EventBus(this, "CustomBus", {
      eventBusName: `${stackName}-ClaimsProcessingBus`,
    });

    new CfnDiscoverer(this, "SchemaDiscoverer", {
      sourceArn: bus.eventBusArn
    });

    const documentService = new DocumentService(this, "DocumentService", {
      bus,
    });

    const allEventsLogGroup = new LogGroup(this, "AllEventsLogGroup", {
      retention: RetentionDays.ONE_DAY,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const customerService = new CustomerService(this, "CustomerService", {
      bus,
      documentsBucket: documentService.documentsBucket,
    });
    const customerTable = customerService.customerTable;
    const policyTable = customerService.policyTable;

    const claimsService = new ClaimsService(this, "ClaimsService", {
      bus,
      customerTable,
      policyTable,
      documentsBucket: documentService.documentsBucket,
    });
    const claimsTable = claimsService.claimsTable;

    const fraudService = new FraudService(this, "FraudService", {
      bus,
      customerTable,
      policyTable,
      claimsTable,
    });

    // const settlementService = new SettlementService(this, "SettlementService", {
    //   bus,
    // });

    // const vendorService = new VendorService(this, "VendorService", {
    //   bus
    // });

    new NotificationsService(this, "NotificationsService", {
      bus,
      customerTable,
      eventPattern: {
        detailType: [
          CustomerEvents.CUSTOMER_ACCEPTED,
          CustomerEvents.CUSTOMER_REJECTED,
          ClaimsEvents.CLAIM_ACCEPTED,
          ClaimsEvents.CLAIM_REJECTED,
          DocumentsEvents.DOCUMENT_PROCESSED,
          FraudEvents.FRAUD_DETECTED,
          FraudEvents.FRAUD_NOT_DETECTED,
          // SettlementEvents.SETTLEMENT_FINALIZED,
          // VendorEvents.VENDOR_FINALIZED
        ],
      },
    });

    const cleanupService = new CleanupService(this, "CleanupService", {
      customerTableName: customerTable.tableName,
      policyTableName: policyTable.tableName,
      claimsTableName: claimsTable.tableName,
      // settlementTableName: settlementService.table.tableName,
      documentsBucketName: documentService.documentsBucket.bucketName,
    });

    customerTable.grantReadWriteData(cleanupService.cleanupLambdaFunction);
    policyTable.grantReadWriteData(cleanupService.cleanupLambdaFunction);
    claimsTable.grantReadWriteData(cleanupService.cleanupLambdaFunction);
    documentService.documentsBucket.grantReadWrite(
      cleanupService.cleanupLambdaFunction
    );
    // settlementService.table.grantReadWriteData(cleanupService.cleanupLambdaFunction);
    
    const metricsQueueWithLambdaSubscription =
    createMetricsQueueWithLambdaSubscription(this);
    


    new Rule(this, "WildcardCaptureAllEventsRule", {
      eventBus: bus,
      ruleName: "WildcardCaptureAllEventsRule",
      eventPattern: {
        source: [
          CustomerEvents.CUSTOMER_SOURCE,
          CustomerEvents.SIGNUP_SOURCE,
          ClaimsEvents.FNOL_SOURCE,
          ClaimsEvents.CLAIMS_SOURCE,
          DocumentsEvents.SOURCE,
          FraudEvents.SOURCE,
          // SettlementEvents.SOURCE,
          // VendorEvents.SOURCE,
          "aws.s3",
        ],
      },
      targets: [
        new CloudWatchLogGroup(allEventsLogGroup,
          // Log size: By default, the entire event is written to CloudWatch Logs. 
          // If you want to limit the size of the log, you can use the logEvent field (as below)
          // NOTE: The logEvent message must be a string.
          {
            logEvent: LogGroupTargetInput.fromObject({
                timestamp: EventField.fromPath('$.time'),
                message: `type=${EventField.fromPath('$.detail-type')} | correlationId=${EventField.fromPath('$.detail.meta.correlationId')} | source=${EventField.source} | eventId=${EventField.eventId}` ,
              // FAILS: parsing the JSON fromPath('$.detail') before sending to target
              // message: RuleTargetInput.fromText(JSON.stringify(EventField.fromPath('$.detail'))),
            })
          }
        ),
        new SqsQueue(metricsQueueWithLambdaSubscription),
      ],
    });

  
   

    // targetLogGroup.bind(wild, "ebtargetLogGroupTarget");
    // // add a target with inputpath like $.detail  
    // wild.addTarget(targetLogGroup, 
    // ruleTargetInputProperties
    // );

    new ClaimsProcessingCWDashboard(this, "ClaimsProcessingCWDashboard", {
      dashboardName: `${stackName}-${region}-Claims-Processing-Dashboard`,
      graphWidgets: [
        customerService.customerMetricsWidget,
        claimsService.claimsMetricsWidget,
        fraudService.fraudMetricsWidget,
        documentService.documentsMetricsWidget,
        // settlementService.settlementMetricsWidget,
        // vendorService.vendorMetricsWidget,
      ],
    });
  }
}
