// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import  { Logger, injectLambdaContext } from '@aws-lambda-powertools/logger';
import middy from '@middy/core';

const {
  EventBridgeClient,
  PutEventsCommand,
} = require("@aws-sdk/client-eventbridge");
const ebClient = new EventBridgeClient({ region: process.env.AWS_REGION });
const logger = new Logger();

const nakedHandler = async function (event) {

  const meta = {
    correlationId: event.requestContext.requestId || "event.requestContext.requestId NOT FOUND",
  } 

  const eventDetail = {
    meta,
    data: JSON.parse(event.body),
    cognitoIdentityId: event.requestContext.identity.cognitoIdentityId,
  };

  
  // PutEvents
  const command = new PutEventsCommand({
    Entries: [
      {
        DetailType: "Customer.Submitted",
        Source: "signup.service",
        EventBusName: process.env.BUS_NAME,
        Detail: JSON.stringify(eventDetail),
      },
    ],
  });
  
  try {
    await ebClient.send(command);
    const event = {
      DetailType: command.input.Entries[0].DetailType,
      Detail: JSON.parse(command.input.Entries[0].Detail)
    };
    logger.debug("SENT event  to Eventbridge", { event});
  } catch (error) {
    logger.error("Failed send to Eventbridge", error);
  }

  const resp = { message: "Customer Submitted" };

  return {
    statusCode: 200,
    body: JSON.stringify(resp),
    headers: {
      "content-type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    isBase64Encoded: false,
  };
};

exports.handler = middy(nakedHandler).use(
  injectLambdaContext(logger, {
    logEvent: process.env.POWERTOOLS_LOGGER_LOG_EVENT })
);