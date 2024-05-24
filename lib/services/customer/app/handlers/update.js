// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// Get Event Body from Event Bridge
// Update analyzed id document fields in customer item
// Update Customer in database
// Put Events (Customer.Document.Updated)
import  { Logger, injectLambdaContext } from '@aws-lambda-powertools/logger';
import middy from '@middy/core';

const { DynamoDBClient, PutItemCommand } = require("@aws-sdk/client-dynamodb");
const { marshall } = require("@aws-sdk/util-dynamodb");
const {
  EventBridgeClient,
  PutEventsCommand,
} = require("@aws-sdk/client-eventbridge");

const ebClient = new EventBridgeClient({ region: process.env.AWS_REGION });
const docClient = new DynamoDBClient();
const logger = new Logger();

const nakedHandler = async function (event, context) {
  const {
    detail: { meta, customerId, analyzedFieldAndValues, documentType },
  } = event;

  try {
    const params = {
      TableName: process.env.CUSTOMER_TABLE_NAME,
      Item: marshall({
        PK: customerId,
        SK: `${documentType}`,
        ...analyzedFieldAndValues,
      }),
    };

    const result = await docClient.send(new PutItemCommand(params));

    const command = new PutEventsCommand({
      Entries: [
        {
          DetailType: "Customer.Document.Updated",
          Source: "customer.service",
          EventBusName: process.env.BUS_NAME,
          Detail: JSON.stringify({
            meta,
            customerId,
            documentType,
          }),
        },
      ],
    });

    const response = await ebClient.send(command);
    const document = {
      DetailType: command.input.Entries[0].DetailType,
      Detail: JSON.parse(command.input.Entries[0].Detail)
    }
    logger.info("Published Document Update", { document });
  
  } catch (error) {
    logger.error(error);
  }

  return {
    statusCode: 201,
    body: "Customer Document Updated",
  };
};

exports.handler = middy(nakedHandler).use(
  injectLambdaContext(logger, {
    logEvent: process.env.POWERTOOLS_LOGGER_LOG_EVENT })
);