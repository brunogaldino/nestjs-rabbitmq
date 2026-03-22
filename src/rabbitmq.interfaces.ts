import { ChannelWrapper } from "amqp-connection-manager";
import { ConfirmChannel, ConsumeMessage } from "amqplib";
import { RabbitMQModuleOptions } from "./rabbitmq.types";

export type RabbitConsumerParameters = {
  message: ConsumeMessage;
  channel: ConfirmChannel;
  queue: string;
};

export interface IRabbitHandler<T = any> {
  (content: T, parameters?: RabbitConsumerParameters): Promise<void>;
}

export interface IRabbitDeadletterCallback<T = any> {
  (content: T): Promise<boolean> | boolean;
}

export interface IDelayProgression {
  (content: any, attempt: number, exception: Error): Promise<number> | number;
}

export interface RabbitOptionsFactory {
  createRabbitOptions(): RabbitMQModuleOptions;
}

export interface RabbitChannel {
  exchangeType: string;
  wrapper: ChannelWrapper;
}

export interface IRabbitConsumer<T = any> {
  messageHandler(
    content: T,
    parameters?: RabbitConsumerParameters,
  ): Promise<void>;
}
