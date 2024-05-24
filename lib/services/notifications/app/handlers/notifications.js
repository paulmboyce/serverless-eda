// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import  { Logger, injectLambdaContext } from '@aws-lambda-powertools/logger';
import middy from '@middy/core';

import {
  IoTDataPlaneClient,
  PublishCommand,
} from "@aws-sdk/client-iot-data-plane";

const { DynamoDBClient, GetItemCommand } = require("@aws-sdk/client-dynamodb");
const { marshall, unmarshall } = require("@aws-sdk/util-dynamodb");

const docClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const client = new IoTDataPlaneClient({ region: process.env.AWS_REGION });

const logger = new Logger();

const nakedHandler = async function (event) {

logger.info("LOG LEVEL is ======> " + logger.getLevelName())

logger.info("ENV INFO", {env :process.env})
logger.debug("ENV DEBUG", {env :process.env})
logger.warn("ENV WARN", {env :process.env})

  const { cognitoIdentityId, customerId } = event.detail;
  const identityId = cognitoIdentityId ? cognitoIdentityId : await getIdentityId(customerId);

  const input = {
    payload: JSON.stringify(event),
    topic: identityId,
  };

  const command = new PublishCommand(input);

  try {
    const response = await client.send(command);
    logger.debug("Published notification to IoT", {input}, {response});
  } catch (error) {
    logger.error("error publishing to IoT ", {error});
  }

  return "Notifications Lambda called";
};

async function getIdentityId(customerId) {
  const customerCognitoCommand = new GetItemCommand({
    TableName: process.env.CUSTOMER_TABLE_NAME,
    Key: marshall(
      {
        PK: customerId,
        SK: "COGNITO_IDENTITY_ID",
      },
      { removeUndefinedValues: true }
    ),
    ProjectionExpression: "cognitoIdentityId",
  });

  const { Item } = await docClient.send(customerCognitoCommand);
  const item = unmarshall(Item);

  return item.cognitoIdentityId;
}

exports.handler = middy(nakedHandler).use(
  injectLambdaContext(logger, {
    logEvent: process.env.POWERTOOLS_LOGGER_LOG_EVENT })
);