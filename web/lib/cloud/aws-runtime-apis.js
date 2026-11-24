/** Verified data-plane entries. These are not aliases for creating new infrastructure. */
export const AWS_RUNTIME_APIS = {
  'amazon-neptunedata': {
    setupService: 'amazon-neptune',
    message: 'NeptuneData runs graph/status operations against an existing Neptune database. Open Neptune setup separately to create a target and configure query roles.',
    reference: 'https://docs.aws.amazon.com/neptune/latest/data-api/API_Operations.html',
  },
  'amazon-bedrock-runtime': {
    setupService: 'amazon-bedrock',
    message: 'Bedrock Runtime invokes existing models. Open Bedrock setup for the supported regional model, role, guardrail and client integration.',
    reference: 'https://docs.aws.amazon.com/bedrock/latest/APIReference/API_Operations_Amazon_Bedrock_Runtime.html',
  },
  'amazon-dynamodb-streams': {
    setupService: 'amazon-dynamodb',
    message: 'DynamoDB Streams reads changes from an existing table stream. Stream configuration belongs to the table setup; a stream consumer needs separate permissions and processing.',
    reference: 'https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_Operations_Amazon_DynamoDB_Streams.html',
  },
}         ;
