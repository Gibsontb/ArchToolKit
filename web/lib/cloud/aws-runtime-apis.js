/** Verified data-plane entries. These are not aliases for creating new infrastructure. */
export const AWS_RUNTIME_APIS = {
  'aws-appconfig-data': {
    setupService:'aws-appconfig',
    message:'AppConfig Data retrieves already-deployed configuration using StartConfigurationSession and GetLatestConfiguration. Open AppConfig setup for the application, environment and configuration profile. AWS recommends the AppConfig Agent for retrieval; protect configuration/session tokens and qualify scoped consumer permissions, polling and application behavior separately. This API does not deploy a second application.',
    reference:'https://docs.aws.amazon.com/appconfig/latest/userguide/about-data-plane.html',
  },
  'aws-iot-data-plane': {
    setupService:'aws-iot-core',
    message:'IoT Data publishes MQTT messages and operates on existing device shadows/retained data. Open IoT Core setup for the existing service resources and policies. Runtime messaging, endpoint/device identity, topic/shadow permissions and data handling need a separate authorized application flow; publishing can have device side effects and an empty retained payload can delete retained data.',
    reference:'https://docs.aws.amazon.com/iot/latest/apireference/API_iotdata_Publish.html',
  },
  'aws-signer-data-plane': {
    setupService:'aws-signer',
    message:'Signer Data Plane retrieves revocation status for existing signed artifacts. Open Signer setup for signing profiles and related resources. Revocation checks are separate from creating a profile, signing an artifact and validating its full signature/trust chain; the existing resource builders do not constitute a complete artifact verification client.',
    reference:'https://docs.aws.amazon.com/service-authorization/latest/reference/list_signer.html',
  },
  'amazon-kinesis-video-webrtc-storage': {
    setupService: 'amazon-kinesis-video-streams',
    message: 'WebRTC Storage joins cloud storage sessions for an existing configured channel. Open Kinesis Video Streams setup and select retained-media ingestion preparation for the scoped participant policies and separately confirmed association operation. Joining a session is a distinct application/media action; GovCloud ingestion/storage is unavailable.',
    reference: 'https://docs.aws.amazon.com/kinesisvideostreams/latest/APIReference/API_Operations.html',
  },
  'amazon-kinesis-video-signaling-channels': {
    setupService: 'amazon-kinesis-video-streams',
    message: 'The Signaling Channels API obtains ICE configuration for existing WebRTC channels. Open Kinesis Video Streams setup and select the single-master WebRTC signaling workflow, separately from MKV stream setup. ICE responses contain temporary relay credentials; SDK peers, media handling and effective access need separate application qualification.',
    reference: 'https://docs.aws.amazon.com/kinesisvideostreams/latest/APIReference/API_Operations.html',
  },
  'amazon-kinesis-video-streams-media': {
    setupService: 'amazon-kinesis-video-streams',
    message: 'Kinesis Video Media reads or publishes media against an existing stream through GetMedia/PutMedia and its discovered data endpoint. Open Kinesis Video Streams setup for the stream and access configuration. Producer credentials, retention, media handling and explicit data operations require separate application review.',
    reference: 'https://docs.aws.amazon.com/kinesisvideostreams/latest/APIReference/API_Operations.html',
  },
  'amazon-kinesis-video-streams-archived-media': {
    setupService: 'amazon-kinesis-video-streams',
    message: 'Archived Media reads retained stream fragments, clips/images and playback sessions. Open Kinesis Video Streams setup separately. Playback URLs contain access tokens; protect them as credentials and verify the selected stream retention and data authorization before reading media.',
    reference: 'https://docs.aws.amazon.com/kinesisvideostreams/latest/APIReference/API_Operations.html',
  },
  'amazon-connect-participant-service': {
    setupService: 'amazon-connect-customer',
    message: 'Connect Participant manages connections, messages, attachments and transcripts for an existing contact. Open Connect Customer setup for the contact-center resources. Participant/connection tokens and chat data require a separately authorized application flow; these APIs do not provision a new contact center.',
    reference: 'https://docs.aws.amazon.com/connect/latest/APIReference/API_connect-participant_CreateParticipantConnection.html',
  },
  'amazon-eks-auth': {
    setupService: 'amazon-elastic-kubernetes-service',
    message: 'EKS Auth supplies temporary workload credentials to the EKS Pod Identity Agent. Open EKS setup for the existing-cluster Pod Identity association workflow. Applications use the SDK container credential provider; they do not call this agent API directly.',
    reference: 'https://docs.aws.amazon.com/eks/latest/APIReference/API_auth_AssumeRoleForPodIdentity.html',
  },
  'amazon-sagemaker-runtime': {
    setupService: 'amazon-sagemaker-ai',
    message: 'SageMaker Runtime invokes existing hosted endpoints. Open SageMaker AI setup to create the supported single-model CPU endpoint and private synchronous client access; asynchronous and streaming deployments require separate workflows.',
    reference: 'https://docs.aws.amazon.com/sagemaker/latest/APIReference/API_Operations_Amazon_SageMaker_Runtime.html',
  },
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
