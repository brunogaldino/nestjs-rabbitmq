import { ChannelWrapper } from "amqp-connection-manager";
import { ConfirmChannel, ConsumeMessage } from "amqplib";
import { RabbitMQModuleOptions } from "./rabbitmq.types";

export type RabbitMQConsumerParameters = {
  message: ConsumeMessage;
  channel: ConfirmChannel;
  queue: string;
};

export interface IRabbitMQHandler<T = any> {
  (content: T, parameters?: RabbitMQConsumerParameters): Promise<void>;
}

export interface IRabbitDeadletterCallback<T = any> {
  (content: T): Promise<boolean> | boolean;
}

export interface IDelayProgression {
  (content: any, attempt: number, exception: Error): Promise<number> | number;
}

export interface RabbitMQOptionsFactory {
  createRabbitOptions(): RabbitMQModuleOptions;
}

export interface RabbitMQChannel {
  exchangeType: string;
  wrapper: ChannelWrapper;
}

export interface IRabbitMQConsumer<T = any> {
  messageHandler(
    content: T,
    parameters?: RabbitMQConsumerParameters,
  ): Promise<void>;
}
