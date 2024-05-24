// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import  { Logger, injectLambdaContext } from '@aws-lambda-powertools/logger';
import middy from '@middy/core';

import { Tracer } from '@aws-lambda-powertools/tracer';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
const tracer = new Tracer();

const {
  EventBridgeClient,
  PutEventsCommand,
} = require("@aws-sdk/client-eventbridge");

// Wrap the EventBridgeClient with the tracer
const ebClient = tracer.captureAWSv3Client(new EventBridgeClient({ region: process.env.AWS_REGION }));
const logger = new Logger();
/**
 * 
 * @param {*} event - String. event from is a JSON string, so need to parse before treating as an object 
 * @returns 
 */
const nakedHandler = async function (event) {

  const detail = JSON.parse(event.body);
  detail.meta = {
      correlationId: event?.requestContext?.requestId
        || "event.requestContext.requestId NOT FOUND",
  } 

  const entry = {
    DetailType: "Claim.Requested",
    Source: "fnol.service",
    EventBusName: process.env.BUS_NAME,
    Detail: JSON.stringify(detail),
  };

  
  // PutEvents (detailType: Claim.Requested)
  const command = new PutEventsCommand({
    Entries: [
      entry
    ],
  });
  
  try {
    const response = await ebClient.send(command);
    logger.debug("SENT: EventBridge PutEventsCommand Payload: ", {entry});
  }
  catch (error) {
    logger.error("Error sending to Eventbridge", { error });
    return errorResponseWithTraceId(error)
  }

  return {
    statusCode: 200,
    body: "Claim Requested",
    headers: {
      "content-type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    isBase64Encoded: false,
  };
};

// return an error response with root xray trace id
const errorResponseWithTraceId = (error) => { 
  const rootTraceId = tracer.getRootXrayTraceId();
  logger.debug("Response as Error response with trace id", {rootTraceId });
    return {
      statusCode: 500,
      body: `Internal Error - Please contact support and quote the following id: [${rootTraceId}]`,
      headers: {
        _X_AMZN_TRACE_ID: rootTraceId,
        "content-type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      isBase64Encoded: false,
    };
}

exports.handler = middy(nakedHandler)
  .use(injectLambdaContext(logger, {
    logEvent: process.env.POWERTOOLS_LOGGER_LOG_EVENT
  }))
  .use(captureLambdaHandler(tracer));
