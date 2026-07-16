// Compatibility assertions against the current generated Workers runtime types.
// This catches Cloudflare API drift in the package's dependency-free structural
// types without making @cloudflare/workers-types a runtime dependency.

import type { CloudflareQueue, QueueBatch } from '../src/runtime/server/types'

interface MessageBody {
  id: string
}

declare const generatedQueueBinding: Queue<MessageBody>
declare const generatedQueueBatch: MessageBatch<MessageBody>

const queueBinding: CloudflareQueue<MessageBody> = generatedQueueBinding
const queueBatch: QueueBatch<MessageBody> = generatedQueueBatch

void queueBinding
void queueBatch
