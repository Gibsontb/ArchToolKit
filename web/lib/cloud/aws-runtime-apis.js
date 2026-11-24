/** Verified data-plane entries. These are not aliases for creating new infrastructure. */
export const AWS_RUNTIME_APIS = {
  'amazon-cloudsearch-domain': {
    setupService: 'amazon-cloudsearch',
    message: 'CloudSearch Domain searches, suggests and uploads document batches against an existing domain. Configure the domain and endpoint access separately; uploads can add, update or delete indexed documents. Existing-customer eligibility still applies.',
    reference: 'https://docs.aws.amazon.com/cloudsearch/latest/developerguide/configuring-access.html',
  },
  'amazon-forecast-query-service': {
    setupService: 'amazon-forecast',
    message: 'Forecast Query retrieves existing forecasts and what-if forecasts. Dataset import, training and forecast creation belong to Forecast setup. Existing-customer eligibility still applies.',
    reference: 'https://docs.aws.amazon.com/forecast/latest/dg/API_Operations_Amazon_Forecast_Query_Service.html',
  },
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
