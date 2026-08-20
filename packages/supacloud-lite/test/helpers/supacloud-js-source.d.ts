interface QueueMessage {
  msg_id: number
  payload: Record<string, unknown>
  status?: string
}

interface QueueMutationResult {
  msg_id: number
  status: 'archived' | 'deleted' | 'released'
  success: boolean
}

interface QueueClient {
  send(payload?: Record<string, unknown>, options?: Record<string, unknown>): Promise<QueueMessage>
  sendBatch(messages: Record<string, unknown>[], options?: Record<string, unknown>): Promise<QueueMessage[]>
  read(options?: Record<string, unknown>): Promise<QueueMessage[]>
  receive(options?: Record<string, unknown>): Promise<QueueMessage | null>
  archive(messageId: string | number): Promise<QueueMutationResult>
  ack(messageId: string | number): Promise<QueueMutationResult>
  delete(messageId: string | number): Promise<QueueMutationResult>
}

interface WorkflowRun {
  runId: string
  status: string
  idempotent: boolean
  rowVersion: string
  steps: Array<{
    stepId: string
    stepKey: string
    status: string
    queueMessageId: string
    attempts: number
  }>
}

interface CommandReceipt {
  commandId: string
  commandType: string
  idempotent: boolean
  workflow: WorkflowRun & { output?: Record<string, unknown> }
}

interface CommandClient {
  submit(request: Record<string, unknown>): Promise<CommandReceipt>
  get(commandId: string): Promise<CommandReceipt | null>
}

interface Artifact {
  artifactId: string
  objectVersion: string
  idempotent: boolean
  parents: Array<{ artifactId: string; relationType: string }>
}

interface ArtifactClient {
  register(request: Record<string, unknown>): Promise<Artifact>
  get(artifactId: string): Promise<Artifact | null>
  link(request: Record<string, unknown>): Promise<Artifact>
}

interface WorkflowClient {
  start(request: Record<string, unknown>): Promise<WorkflowRun>
  claim(request: Record<string, unknown>): Promise<Record<string, unknown> | null>
  advance(request: Record<string, unknown>): Promise<WorkflowRun>
  complete(request: Record<string, unknown>): Promise<WorkflowRun>
  retry(request: Record<string, unknown>): Promise<WorkflowRun>
  fail(request: Record<string, unknown>): Promise<WorkflowRun>
  cancel(runId: string, reason: string): Promise<WorkflowRun>
  get(runId: string): Promise<WorkflowRun | null>
  events(runId: string, options?: { afterEventId?: string; limit?: number }): Promise<Array<Record<string, unknown>>>
}

export function createSupaCloudClient(options: {
  supabase: unknown
  managementApiUrl: string
  projectRef: string
}): {
  queue(name: string): QueueClient
  workflows: WorkflowClient
  commands: CommandClient
  artifacts: ArtifactClient
}
