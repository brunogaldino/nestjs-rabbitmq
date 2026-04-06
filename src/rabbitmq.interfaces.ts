import { ChannelWrapper } from "amqp-connection-manager";
import { ConsumeMessage } from "amqplib";
import { ModuleOptions } from "./rabbitmq.types";
import { ModuleMetadata, Type } from "@nestjs/common";

export type MessageParams = {
  message: ConsumeMessage;
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

export interface ModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  /**
   * Factory function that returns the configuration object
   */
  useFactory?: (...args: any[]) => Promise<ModuleOptions> | ModuleOptions;

  /**
   * Optional list of providers to be injected into the factory function.
   */
  inject?: any[];

  imports?: any[];

  providers?: any[];

  /**
   * Optional class that implements the RabbitMQOptionsFactory interface
   */
  useClass?: Type<RabbitMQOptionsFactory>;

  /**
   * Optional existing provider to be reused
   */
  useExisting?: Type<any>;
}
