// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import  { Logger, injectLambdaContext } from '@aws-lambda-powertools/logger';
import middy from '@middy/core';

const {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} = require("@aws-sdk/client-dynamodb");
const { marshall, unmarshall } = require("@aws-sdk/util-dynamodb");
const {
  EventBridgeClient,
  PutEventsCommand,
} = require("@aws-sdk/client-eventbridge");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const ebClient = new EventBridgeClient({ region: process.env.AWS_REGION });
const s3Client = new S3Client({ region: process.env.AWS_REGION });
const crypto = require("crypto");
const docClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const logger = new Logger();

// Create Claims Lambda function polling from Claims queue,
// Verify FNOL information
// Validate Policy (start and end date)
// Validate Personal Information
// Persist in Claims Table (PK = UUID, SK = Customer|<customerId>)
// put events (Claim.Accepted) (should provide a pre-signed url to upload photos of damaged car)
const nakedHandler = async function (event, context) {

  try {
    const {
      "detail-type": detailType,
      detail: {
        meta, 
        incident: {
          occurrenceDateTime,
          fnolDateTime,
          location: { country, state, city, zip, road },
          description,
        },
        policy: { id },
        personalInformation: {
          customerId,
          driversLicenseNumber,
          isInsurerDriver,
          licensePlateNumber,
          numberOfPassengers,
        },
        policeReport: { isFiled, reportOrReceiptAvailable },
        otherParty: { insuranceId, insuranceCompany, firstName, lastName },
      },
    } = JSON.parse(event.Records[0].body);

    if (detailType !== "Claim.Requested") {
      logger.warn("Unsupported Detail Type: " + event.detailType, { event: event.Records[0].body});
      return;
    }

    const eventPayload = {
      source: "claims.service",
      detailType: "",
      detail: { customerId, meta },
    };

    // Get Policies from customer Id
    const queryCommand = new GetItemCommand({
      TableName: process.env.POLICY_TABLE_NAME,
      Key: marshall({
        PK: id,
        SK: `Customer|${customerId}`,
      }),
    });

    const { Item } = await docClient.send(queryCommand);
    logger.debug("Got Result from DDB Query", {Item});

    const policy = unmarshall(Item);
    logger.debug("Got Policies from FNOL data", {policy});

    const policyStartDate = new Date(policy.startDate);
    const policyEndDate = new Date(policy.endDate);
    const incidentDate = new Date(occurrenceDateTime);
    const isValidPolicy =
      policyStartDate < incidentDate && incidentDate < policyEndDate;

    if (!isValidPolicy) {
      eventPayload.detailType = "Claim.Rejected";
      eventPayload.detail = {
        ...eventPayload.detail,
        message:
          "Policy provided for customer does not match or the incident happened outside policy active period",
      };

      await putEvents(eventPayload);
      return;
    }

    const checkedPersonalInformation = await verifyPersonalInformation(
      customerId,
      driversLicenseNumber
    );

    if (!checkedPersonalInformation.valid) {
      
      logger.debug("Verified Personal Info:", { checkedPersonalInformation});
      
      eventPayload.detailType = "Claim.Rejected";
      eventPayload.detail = {
        ...eventPayload.detail,
        message: "Personal information (Driver's License) does not match" + JSON.stringify(checkedPersonalInformation, null, 2),
      };

      await putEvents(eventPayload);
      return;
    }

    const claimId = crypto.randomUUID();

    // Else persist Claims information
    const claimPutItemCommand = new PutItemCommand({
      TableName: process.env.CLAIMS_TABLE_NAME,
      Item: marshall({
        PK: claimId,
        SK: `Customer|${customerId}`,
        occurrenceDateTime,
        fnolDateTime,
        country,
        state,
        city,
        zip,
        road,
        description,
        driversLicenseNumber,
        isInsurerDriver,
        licensePlateNumber,
        numberOfPassengers,
        policeReportFiled: isFiled,
        policeReportReceiptAvailable: reportOrReceiptAvailable,
        otherPartyInsuranceId: insuranceId,
        otherPartyInsuranceCompany: insuranceCompany,
        otherPartyFirstName: firstName,
        otherPartyLastName: lastName,
        policyId: id,
      }),
    });

    const result = await docClient.send(claimPutItemCommand);

    //Create pre-signed url to upload car damage pictures
    const putObjectCommand = new PutObjectCommand({
      Bucket: process.env.BUCKET_NAME,
      Key: `customers/${customerId}/documents/claims/${claimId}/damagedCar.jpg`,
      ContentType: "application/jpg",
    });

    const uploadCarDamageUrl = await getSignedUrl(s3Client, putObjectCommand, {
      expiresIn: 3600,
    });

    eventPayload.detailType = "Claim.Accepted";
    eventPayload.detail = {
      ...eventPayload.detail,
      claimId,
      uploadCarDamageUrl,
      message: "Claim Information has been accepted",
    };

    await putEvents(eventPayload);
  } catch (error) {
    logger.error(error);
  }

  return {
    statusCode: 201,
    body: "Claim Accepted",
  };
};

async function putEvents(eventPayload) {
  const putEventsCommand = new PutEventsCommand({
    Entries: [
      {
        DetailType: eventPayload.detailType,
        Source: eventPayload.source,
        EventBusName: process.env.BUS_NAME,
        Detail: JSON.stringify(eventPayload.detail),
      },
    ],
  });

  return await ebClient.send(putEventsCommand);
}

async function verifyPersonalInformation(customerId, driversLicenseNumber) {
  const customerDocumentCommand = new GetItemCommand({
    TableName: process.env.CUSTOMER_TABLE_NAME,
    Key: marshall({
      PK: customerId,
      SK: "DRIVERS_LICENSE",
    }),
    ProjectionExpression: "DOCUMENT_NUMBER",
  });

  const { Item } = await docClient.send(customerDocumentCommand);
  let item;
  if (Item) item = unmarshall(Item);
  logger.debug("Got Drivers License from Customer Table", {item});

  const valid = item &&
    driversLicenseNumber &&
    item.DOCUMENT_NUMBER === driversLicenseNumber;
    
  return { valid, info: {
    driversLicenseNumber,
    item
  }};
}



exports.handler = middy(nakedHandler).use(
  injectLambdaContext(logger, {
    logEvent: process.env.POWERTOOLS_LOGGER_LOG_EVENT })
);