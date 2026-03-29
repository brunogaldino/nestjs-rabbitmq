import { ChannelWrapper } from "amqp-connection-manager";
import { ConfirmChannel, ConsumeMessage } from "amqplib";
import { ModuleOptions } from "./rabbitmq.types";

export type MessageParams = {
  message: ConsumeMessage;
  channel: ConfirmChannel;
  queue: string;
  originalRoutingKey?: string;
};

export interface IRabbitMQHandler<T = any> {
  (content: T, parameters?: MessageParams): Promise<void>;
}

export interface IRabbitDeadletterCallback<T = any> {
  (content: T): Promise<boolean> | boolean;
}

export interface IDelayProgression {
  (content: any, attempt: number, exception: Error): Promise<number> | number;
}

export interface RabbitMQOptionsFactory {
  createRabbitOptions(): ModuleOptions;
}

export interface RabbitMQChannel {
  exchangeType: string;
  wrapper: ChannelWrapper;
}

export interface ConsumerHandler<T = any> {
  messageHandler(
    content: T,
    parameters?: MessageParams,
  ): Promise<void>;
}
