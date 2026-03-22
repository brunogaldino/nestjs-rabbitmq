import { Logger, ModuleMetadata, Type } from "@nestjs/common";
import {
  IDelayProgression,
  IRabbitDeadletterCallback,
  RabbitOptionsFactory,
} from "./rabbitmq.interfaces";

export type RabbitMQExchangeTypes = "direct" | "topic" | "fanout" | "headers";
export type LogType = "all" | "consumer" | "publisher" | "none";
export type ConnectionType = "consumer" | "publisher";

export type RabbitMQConsumerOptions = {
  /** Name of the Queue */
  queue: string;

  /** The SDK will send an ACK at the end of the consumer function
   * If *disabled* your consumer will need to call channel.ack() manually !
   * @defaultValue true*/
  autoAck?: boolean;

  /** Amount of messages that will be delivered to the consumer at once
   * @default 10 */
  prefetch?: number;

  /** If messages enqueued on the queue will be stored on a persistent disk
   * @remarks **WARNING**: If this option is disabled, the broker will store the messages in-memory. If RabbitMQ goes offline while messages are enqueued, they will be lost!
   * @default: true */
  durable?: boolean;

  /** If the queue needs to be automatically deleted when there are no consumers attached.
   * @remarks **WARNING**: RabbitMQ will delete the queue no matter the amount of messages enqueued.
   * @default: false */
  autoDelete?: boolean;

  /** Name of the Exchange */
  exchangeName: string;

  /** Routing key between the Queue and the exchange. This acts as a filter so only this routing key will be received by the queue.
   * @remarks
   * The parameter accepts an array of routing keys and each entry will be declared.
   * For exchanges of the type `fanout` this parameter will be ignored
   * This parameter accepts patterns
   *
   * @see {@link https://www.cloudamqp.com/blog/part4-rabbitmq-for-beginners-exchanges-routing-keys-bindings.html} for more about routing keys
   *
   * @example
   * webhook.`#` - Routes all messages that contains at least `webhook` in the routing key. (webhooks, webhooks.test)
   * webhook.\*.test - Routes all messages that contains the described patter (webhook.ABC.test, webhook.123.test) */
  routingKey: string | string[];

  /** When the consumer throwns an error. The message will be automatically enqueued to a retry queue. Here you declare the strategies for retrying */
  retryStrategy?: {
    /** If the retry strategy will be executed.
     * @default: true */
    enabled?: boolean;

    /** Maximum amount of attempts before sending the message do the DLQ
     * @default: 5 */
    maxAttempts?: number;

    /** The delay amount in MS before the retry sends the message to the original queue
     * The return can have three effects:
     *  - >1: It will send to the delay queue for that amount of time before returning it to the end of the original queue 
     *  - =0: Should retry right now, and will republish at the end of the original queue 
     *  - -1: Should skip any retrying attempt and send to the DLQStrategy 
     * @default: () => 5000*/
    delay?: IDelayProgression;
  };

  deadLetterStrategy?: {
    /** Callback that will be executed before sending the message to the DLQ
     * This handler will follow the `IRabbitDeadletterCallback` interface and expects
     * the return of a boolean_. If the return is `TRUE`, it will send the message
     * to the DLQ right after, otherwise, it will skip sending it
     * @example messageHandler: this.yourService.deadLetterFunction.bind(this.yourService)
     */
    callback?: IRabbitDeadletterCallback;

    /**
     * Suffix used when setting up the DLQ Queues
     * @default .dlq
     */
    suffix?: string;
  };

  /** Groups are used to define which consumers will be enabled on a given deployment. 
   * The application can define which consumer group will be enabled by setting the `RMQ_CONSUMER_GROUP` environment variable 
   * OR by passing the group during the `createConsumers()` call when `consumerManualLoad = true` option is set
   *
   * By default, all consumers with no defined group will be initialized.
   */
  group?: string;

  // /** Override default suffix that are defined in this library */
  // suffixOptions?: {
  //   /**
  //    * Suffix used when setting up the DLQ Queues
  //    * @default .dlq
  //    */
  //   dlqSuffix?: string;
  // };
};

export type RabbitMQAssertExchange = {
  /** Name of the exchange to be asserted*/
  name: string;

  /** Assert the type of the exchange.
   * @see {@link https://www.rabbitmq.com/tutorials/amqp-concepts} for more information about exchange types */
  type: RabbitMQExchangeTypes;

  options?: {
    /** If messages that passes through this exchange should be stored on a persistent disk
     *  @remarks **WARNING**: If this option is disabled, Rabbit will store the messages in-memory. If RabbitMQ goes offline while messages are enqueued, they will be lost!
     * @default true */
    durable?: boolean;

    /** If the queue needs to be automatically deleted when there are no consumers attached.
     * @remarks **WARNING**: RabbitMQ will delete the queue no matter the amount of messages enqueued.
     * @default false */
    autoDelete?: boolean;

    /** Declare the exchange as a delayed one, in this scenario the exchange will be declated as a `x-delayed-message` with an argument `x-delayed-type: ${type}`
     * @default false */
    isDelayed?: boolean;
  };
};

export type RabbitMQConsumerChannel<T = any> = {
  options: RabbitMQConsumerOptions;
  handler: {
    provider: Type<T>;
    methodName: MethodNames<T>;
  }

  // /** Callback bind that will be declared as consumer
  //  * This handler will follow the `IRabbitHandler` interface
  //  * @example messageHandler: this.yourService.messageHandler.bind(this.yourService)
  //  */
  // messageHandler: IRabbitHandler;
};

export type RabbitMQModuleOptions = {
  /** Connection URI for the RabbitMQ server
   * @example amqp://{user}:{password}@{url}/{vhost}
   * */
  connectionString: string | string[];

  /** The name of the centralized retry exchange that will be used
   * a `.delay` will be added to the given name
   * Will be asserted if it does not exists*/
  delayExchangeName: string;

  // /** When **TRUE**, the connection will be made synchronously during the `OnModuleInit` lifecycle
  //  * and will only return after the connection is sucessfully made
  //  * When **FALSE**, the connection is made asynchronously and will release the lifecycle event as fast as possible.
  //  @ deprecated
  //  * Default: true */
  // waitConnection?: boolean;

  /** All exchanges declared here will be validated before attaching the consumers
   * If any of the exchanegs declared can not be asserted an error will be thrown */
  assertExchanges?: Array<RabbitMQAssertExchange>;

  /** Array of consumers that will be attached to the application*/
  consumerChannels?: Array<RabbitMQConsumerChannel>;

  extraOptions?: {
    /** When **TRUE** the SDK will not initiate the consumers automatically during the _OnModuleInit_
     * To initiate the consumer, you can call it at the end of the `bootstrap()` on your `main.ts` file
     * @default false
     * @example
     * ```javascript
     * const rabbitService: RabbitMQService = app.get(RabbitMQService);
     * await rabbitService.beginConsumers();
     * ``` */
    consumerManualLoad?: boolean;

    /** Enables the message inspection of different parts of the RabbitMQ
     * this option can be overriden by using the env RABBITMQ_LOG_TYPE */
    logType?: LogType;

    /**
     *  Interval to send heartbeats to the broker.
     * @default 5 seconds
     * @remarks
     * More info on {@link https://www.rabbitmq.com/docs/heartbeats}
     */
    heartbeatIntervalInSeconds?: number;

    /**
     * Time between reconnection attempts when a channel/broker connection fails
     * @default 5 seconds */
    reconnectTimeInSeconds?: number;
  };
};

export interface RabbitMQModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  /**
   * Factory function that returns the configuration object
   */
  useFactory?: (...args: any[]) => Promise<RabbitMQModuleOptions> | RabbitMQModuleOptions;

  /**
   * Optional list of providers to be injected into the factory function.
   */
  inject?: any[];

  imports?: any[];

  providers?: any[];

  /**
   * Optional class that implements the RabbitMQOptionsFactory interface
   */
  useClass?: Type<RabbitOptionsFactory>;

  /**
   * Optional existing provider to be reused
   */
  useExisting?: Type<any>;
}

// Define a type that extracts only method names from a class
export type MethodNames<T> = {
  // eslint-disable-next-line @typescript-eslint/ban-types
  [K in keyof T]: T[K] extends Function ? K : never;
}[keyof T] & string;

export function defineRabbitConsumer<T>(
  config: RabbitMQConsumerChannel<T>
): RabbitMQConsumerChannel<T> {
  return config;
}

