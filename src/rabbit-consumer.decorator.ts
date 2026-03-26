// rabbit-consumer.decorator.ts
import { SetMetadata } from '@nestjs/common';
import { RabbitMQConsumerOptions } from './rabbitmq.types';

export const RABBIT_HANDLER_METADATA = 'RABBIT_HANDLER_METADATA';

/**
 * Decorator to mark a method as a RabbitMQ consumer.
 * This will automatically setup the Main Queue, Retry Queue (.retry), and DLQ (.dlq).
 */
export const RabbitConsumer = (options: RabbitMQConsumerOptions) =>
  SetMetadata(RABBIT_HANDLER_METADATA, options);
