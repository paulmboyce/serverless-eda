// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import  { Logger, injectLambdaContext } from '@aws-lambda-powertools/logger';
import middy from '@middy/core';
const {
  DynamoDBClient,
  QueryCommand,
  GetItemCommand,
} = require("@aws-sdk/client-dynamodb");
const { unmarshall } = require("@aws-sdk/util-dynamodb");
const {
  EventBridgeClient,
  PutEventsCommand,
} = require("@aws-sdk/client-eventbridge");

const ebClient = new EventBridgeClient({ region: process.env.AWS_REGION });
const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const logger = new Logger();

const nakedHandler = async function (event, ctx) {
  const { documentType } = event.detail;

  switch (documentType) {
    case "DRIVERS_LICENSE":
      await checkIdentityFraud(event.detail);
      break;
    case "CAR":
      await checkInsuredAssetFraud(event.detail);
      break;
    default:
      break;
  }

  return "Fraud Detection Lambda called";
};

async function checkIdentityFraud({
  customerId,
  analyzedFieldAndValues,
  documentType,
  meta
}) {
  let fraud = {},
    putEventsCommand;

  const params = {
    KeyConditionExpression: "PK = :s",
    ExpressionAttributeValues: {
      ":s": { S: customerId },
    },
    TableName: process.env.CUSTOMER_TABLE_NAME,
  };

  try {
    const { Items } = await ddbClient.send(new QueryCommand(params));

    let item;
    for (let index = 0; index < Items.length; index++) {
      const iterItem = Items[index];
      if (iterItem.firstname) {
        item = unmarshall(iterItem);
        break;
      }
    }

    logger.info("Got Item from DB",  { item });


    fraud.isDetected =
      item?.firstname &&
      analyzedFieldAndValues?.FIRST_NAME &&
      item.firstname?.toLowerCase() !==
        analyzedFieldAndValues.FIRST_NAME?.toLowerCase();

    if (fraud.isDetected) {
      fraud.reason =
        "First Name provided does not match with First Name in Driver's License";
    }




    if (fraud.isDetected) {
      putEventsCommand = new PutEventsCommand({
        Entries: [
          {
            DetailType: "Fraud.Detected",
            Source: "fraud.service",
            EventBusName: process.env.BUS_NAME,
            Detail: JSON.stringify({
              meta,
              customerId,
              documentType,
              fraudType: "DOCUMENT",
              fraudReason: fraud.reason,
            }),
          },
        ],
      });
    } else {
      putEventsCommand = new PutEventsCommand({
        Entries: [
          {
            DetailType: "Fraud.Not.Detected",
            Source: "fraud.service",
            EventBusName: process.env.BUS_NAME,
            Detail: JSON.stringify({
              meta,
              customerId,
              documentType,
              analyzedFieldAndValues,
              fraudType: "DOCUMENT",
            }),
          },
        ],
      });
    }
    
    await ebClient.send(putEventsCommand);
    const event = {
      DetailType: putEventsCommand.input.Entries[0].DetailType,
      Detail: JSON.parse(putEventsCommand.input.Entries[0].Detail)
    };
    logger.info("Published Fraud Result", { fraud:event });
  } catch (e) {
    logger.error(e);
  }
}

async function checkInsuredAssetFraud({
  customerId,
  recordId,
  analyzedFieldAndValues,
  documentType,
  meta
}) {
  let fraudReason;

  if (analyzedFieldAndValues && analyzedFieldAndValues.type === "claims") {
    fraudReason = "No damage detected.";
    fraudReason = await checkClaimsFraud(
      customerId,
      recordId,
      analyzedFieldAndValues,
      fraudReason
    );
    await publishInsuredAssetFraudResult({
      customerId,
      recordId,
      documentType,
      analyzedFieldAndValues,
      fraudReason,
      fraudType: "CLAIMS",
      meta,
    });
  } else if (analyzedFieldAndValues.type === "signup") {
    const policy = await getPolicyRecord(recordId, customerId);
    fraudReason = matchColor(analyzedFieldAndValues.color, policy);
    await publishInsuredAssetFraudResult({
      customerId,
      recordId,
      documentType,
      analyzedFieldAndValues,
      fraudReason,
      fraudType: "SIGNUP.CAR",
      meta
    });
  }
}

async function checkClaimsFraud(
  customerId,
  claimId,
  { damage, color },
  fraudReason
) {
  if (damage && damage.Name !== "unknown") {
    const claimRecord = await getClaimRecord(claimId, customerId);
    const policy = await getPolicyRecord(claimRecord.policyId, customerId);
    fraudReason = matchColor(color, policy);
  }
  return fraudReason;
}

async function publishInsuredAssetFraudResult({
  customerId,
  recordId,
  documentType,
  analyzedFieldAndValues,
  fraudReason,
  fraudType,
  meta
}) {
  let entry = {
    DetailType: "Fraud.Not.Detected",
    Source: "fraud.service",
    EventBusName: process.env.BUS_NAME,
    Detail: JSON.stringify({
      meta,
      customerId,
      recordId,
      documentType,
      analyzedFieldAndValues,
      fraudType,
    }),
  };

  if (fraudReason) {
    entry.DetailType = "Fraud.Detected";
    entry.Detail = JSON.stringify({
      meta,
      customerId,
      recordId,
      documentType,
      fraudType,
      fraudReason,
    });
  }

  let putEventsCommand = new PutEventsCommand({
    Entries: [entry],
  });

  await ebClient.send(putEventsCommand);

  const fraud = {
    DetailType: putEventsCommand.input.Entries[0].DetailType,
    Detail: JSON.parse(putEventsCommand.input.Entries[0].Detail)
  }
  logger.info("Published Fraud Result", { fraud });
}

function matchColor(color, policy) {
  let fraudReason;

  if (
    !color ||
    !color.Name ||
    color.Name.toLowerCase() !== policy.color.toLowerCase()
  ) {
    fraudReason = `Color of vehicle doesn't match the color on the policy. image:[${color?.Name}]policy:[${policy.color}]`;
  }

  return fraudReason;
}

async function getPolicyRecord(policyId, customerId) {
  const getPolicyParams = {
    Key: {
      PK: { S: policyId },
      SK: { S: `Customer|${customerId}` },
    },
    TableName: process.env.POLICY_TABLE_NAME,
  };

  const { Item: policyItem } = await ddbClient.send(
    new GetItemCommand(getPolicyParams)
  );

  const policy = unmarshall(policyItem);
  return policy;
}

async function getClaimRecord(claimId, customerId) {
  const getClaimsParams = {
    Key: {
      PK: { S: claimId },
      SK: { S: `Customer|${customerId}` },
    },
    TableName: process.env.CLAIMS_TABLE_NAME,
  };

  const { Item: claimsItem } = await ddbClient.send(
    new GetItemCommand(getClaimsParams)
  );

  const claimRecord = unmarshall(claimsItem);
  return claimRecord;
}

exports.handler = middy(nakedHandler).use(
  injectLambdaContext(logger, {
    logEvent: process.env.POWERTOOLS_LOGGER_LOG_EVENT })
);