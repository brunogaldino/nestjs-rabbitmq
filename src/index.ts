export { RabbitMQModule } from "./rabbitmq.module";
export { RabbitMQService } from "./rabbitmq-service";
export { RABBIT_OPTIONS } from "./rabbitmq.constants";
export { ConfirmChannel, ConsumeMessage } from "amqplib";
export {
  ConsumerHandler,
  RabbitMQOptionsFactory,
  MessageParams
} from "./rabbitmq.interfaces";
export {
  Exchange,
  ExchangeType,
  ModuleOptions,
  ConnectionConfig,
  ConsumerOptions,
  ConsumerChannel,
  defineRabbitConsumer,
} from "./rabbitmq.types";

export { RabbitConsumer, RABBIT_HANDLER_METADATA } from "./rabbit-consumer.decorator";

