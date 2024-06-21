import { defineBackend } from "@aws-amplify/backend";
import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { storage } from "./storage/resource";

import * as dynamodb from "aws-cdk-lib/aws-dynamodb";

import * as opensearch from "aws-cdk-lib/aws-opensearchservice";
import * as iam from "aws-cdk-lib/aws-iam";

import * as osis from "aws-cdk-lib/aws-osis";
import * as logs from "aws-cdk-lib/aws-logs";
import { RemovalPolicy } from "aws-cdk-lib";

import { Stack } from "aws-cdk-lib";
import { CfnIdentityPool } from "aws-cdk-lib/aws-cognito";

/**
 * @see https://docs.amplify.aws/react/build-a-backend/ to add storage, functions, and more
 */
const backend = defineBackend({
  auth,
  data,
  storage,
});

// extract L1 CfnUserPool resources
const { cfnUserPool } = backend.auth.resources.cfnResources;
// update the schema property to add custom attributes
if (Array.isArray(cfnUserPool.schema)) {
  cfnUserPool.schema.push({
    name: "companyName",
    attributeDataType: "String",
    stringAttributeConstraints: {
      maxLength: "100",
    },
  });
}

// setup search for products
const productTable =
  backend.data.resources.cfnResources.amplifyDynamoDbTables["Product"];
// Update table settings
productTable.pointInTimeRecoveryEnabled = true;
productTable.streamSpecification = {
  streamViewType: dynamodb.StreamViewType.NEW_IMAGE,
};

// Get the DynamoDB table ARN
const tableArn = backend.data.resources.tables["Product"].tableArn;
// Get the DynamoDB table name
const tableName = backend.data.resources.tables["Product"].tableName;

// Get the data stack
const dataStack = Stack.of(backend.data);

// Create the OpenSearch domain
const openSearchDomain = new opensearch.Domain(dataStack, "OpenSearchDomain", {
  version: opensearch.EngineVersion.OPENSEARCH_2_11,
  nodeToNodeEncryption: true,
  encryptionAtRest: {
    enabled: true,
  },
});

// Get the S3Bucket ARN
const s3BucketArn = backend.storage.resources.bucket.bucketArn;
// Get the S3Bucket Name
const s3BucketName = backend.storage.resources.bucket.bucketName;
//Get the region
const region = dataStack.region;

// Create an IAM role for OpenSearch integration
const openSearchIntegrationPipelineRole = new iam.Role(
  dataStack,
  "OpenSearchIntegrationPipelineRole",
  {
    assumedBy: new iam.ServicePrincipal("osis-pipelines.amazonaws.com"),
    inlinePolicies: {
      openSearchPipelinePolicy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            actions: ["es:DescribeDomain"],
            resources: [
              openSearchDomain.domainArn,
              openSearchDomain.domainArn + "/*",
            ],
            effect: iam.Effect.ALLOW,
          }),
          new iam.PolicyStatement({
            actions: ["es:ESHttp*"],
            resources: [
              openSearchDomain.domainArn,
              openSearchDomain.domainArn + "/*",
            ],
            effect: iam.Effect.ALLOW,
          }),
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
              "s3:GetObject",
              "s3:AbortMultipartUpload",
              "s3:PutObject",
              "s3:PutObjectAcl",
            ],
            resources: [s3BucketArn, s3BucketArn + "/*"],
          }),
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
              "dynamodb:DescribeTable",
              "dynamodb:DescribeContinuousBackups",
              "dynamodb:ExportTableToPointInTime",
              "dynamodb:DescribeExport",
              "dynamodb:DescribeStream",
              "dynamodb:GetRecords",
              "dynamodb:GetShardIterator",
            ],
            resources: [tableArn, tableArn + "/*"],
          }),
        ],
      }),
    },
    managedPolicies: [
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        "AmazonOpenSearchIngestionFullAccess"
      ),
    ],
  }
);

// Define OpenSearch index mappings
const indexName = "product";

const indexMapping = {
  settings: {
    number_of_shards: 1,
    number_of_replicas: 0,
  },
  mappings: {
    properties: {
      id: {
        type: "keyword",
      },
      code: {
        type: "text",
      },
      name: {
        type: "text",
      },
      price: {
        type: "float",
      },
    },
  },
};

// OpenSearch template definition
const openSearchTemplate = `
version: "2"
dynamodb-pipeline:
  source:
    dynamodb:
      acknowledgments: true
      tables:
        - table_arn: "${tableArn}"
          stream:
            start_position: "LATEST"
          export:
            s3_bucket: "${s3BucketName}"
            s3_region: "${region}"
            s3_prefix: "${tableName}/"
      aws:
        sts_role_arn: "${openSearchIntegrationPipelineRole.roleArn}"
        region: "${region}"
  sink:
    - opensearch:
        hosts:
          - "https://${openSearchDomain.domainEndpoint}"
        index: "${indexName}"
        index_type: "custom"
        template_content: |
          ${JSON.stringify(indexMapping)}
        document_id: '\${getMetadata("primary_key")}'
        action: '\${getMetadata("opensearch_action")}'
        document_version: '\${getMetadata("document_version")}'
        document_version_type: "external"
        bulk_size: 4
        aws:
          sts_role_arn: "${openSearchIntegrationPipelineRole.roleArn}"
          region: "${region}"
`;

// // NOTICE: This block of code is commented out because it causes the deployment to fail
// // Create a CloudWatch log group
// const logGroup = new logs.LogGroup(dataStack, "LogGroup", {
//   logGroupName: "/aws/vended-logs/OpenSearchService/pipelines/1",
//   removalPolicy: RemovalPolicy.DESTROY,
// });
// // Comment END

// Create an OpenSearch Integration Service pipeline
const cfnPipeline = new osis.CfnPipeline(
  dataStack,
  "OpenSearchIntegrationPipeline",
  {
    maxUnits: 4,
    minUnits: 1,
    pipelineConfigurationBody: openSearchTemplate,
    pipelineName: "dynamodb-integration-2",
    // // NOTICE: This block of code is commented out because it causes the deployment to fail
    // logPublishingOptions: {
    //   isLoggingEnabled: true,
    //   cloudWatchLogDestination: {
    //     logGroup: logGroup.logGroupName,
    //   },
    // },
    // Comment END
  }
);

// Add OpenSearch data source
const osDataSource = backend.data.addOpenSearchDataSource(
  "osDataSource",
  openSearchDomain
);
