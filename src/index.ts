export { RabbitMQModule } from "./rabbitmq.module";
export { RabbitMQService } from "./rabbitmq-service";
export { AMQPConnectionManager } from "./amqp-connection-manager"
export { ConfirmChannel, ConsumeMessage } from "amqplib";
export {
  IRabbitMQConsumer,
  RabbitMQOptionsFactory,
  RabbitMQConsumerParameters,
} from "./rabbitmq.interfaces";
export {
  RabbitMQExchangeTypes,
  RabbitMQModuleOptions,
  RabbitMQAssertExchange,
  RabbitMQConsumerOptions,
  RabbitMQConsumerChannel,
  defineRabbitConsumer,
} from "./rabbitmq.types";
