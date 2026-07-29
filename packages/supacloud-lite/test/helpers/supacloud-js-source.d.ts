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

export function createSupaCloudClient(options: {
  supabase: unknown
  managementApiUrl: string
  projectRef: string
}): {
  queue(name: string): QueueClient
}
