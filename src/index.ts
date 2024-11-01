export { RabbitMQModule } from "./rabbitmq.module";
export { RabbitMQService } from "./rabbitmq-service";
export { ConfirmChannel, ConsumeMessage } from "amqplib";
export {
  IRabbitConsumer,
  RabbitOptionsFactory,
  RabbitConsumerParameters,
} from "./rabbitmq.interfaces";
export {
  RabbitMQExchangeTypes,
  RabbitMQModuleOptions,
  RabbitMQAssertExchange,
  RabbitMQConsumerOptions,
  RabbitMQConsumerChannel,
  PublishOptions,
} from "./rabbitmq.types";

export * from "./test/rabbitmq-test.module";
