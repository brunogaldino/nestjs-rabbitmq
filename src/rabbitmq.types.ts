import { Type } from "@nestjs/common";
import {
  IRetryProgression,
  IDLQFn,
  IRabbitMQHandler,
} from "./rabbitmq.interfaces";

export type ExchangeType = "direct" | "topic" | "fanout" | "headers";
export type LogType = "all" | "consumer" | "publisher" | "none";
export type ConnectionType = "consumer" | "publisher";

export type ConnectionConfig = {
  name: string;
  connectionString: string | string[];
  assertExchanges?: Array<Exchange>;
  consumerChannels?: Array<ConsumerChannel>;
};

export type ConsumerOptions = {
  /** If consumer should be enabled or not
   * @default true
   */
  enabled?: boolean;

  /** Used for multi-vhost connections.
   * When only one connection is used, there is no need to give this attribute 
   * otherwise, pass the name of the connection this consumer should attach
   * @default "default"
  */
  connection?: string;

  /** Name of the Queue */
  queue: string;

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
     * 
     * Accepts a function or a string referencing a method name on the same class.
     * When using a string, the method is resolved and bound automatically at discovery time.
     * @default: () => 5000*/
    retryFn?: IRetryProgression | string;
  };

  dlqStrategy?: {
    /** Callback that will be executed before sending the message to the DLQ
     * This handler will follow the `IDLQFn` interface and expects
     * the return of a boolean. If the return is `TRUE`, it will send the message
     * to the DLQ right after, otherwise, it will skip sending it
     * 
     * Accepts a function or a string referencing a method name on the same class.
     * When using a string, the method is resolved and bound automatically at discovery time.
     */
    dlqFn?: IDLQFn | string;

    /**
     * Suffix used when setting up the DLQ Queues
     * @default .dlq
     */
    suffix?: string;
  };
};

export type Exchange = {
  /** Name of the exchange to be asserted*/
  name: string;

  /** Assert the type of the exchange.
   * @see {@link https://www.rabbitmq.com/tutorials/amqp-concepts} for more information about exchange types */
  type: ExchangeType;

  options?: {
    /** If messages that passes through this exchange should be stored on a persistent disk
     *  @remarks **WARNING**: If this option is disabled, Rabbit will store the messages in-memory. If RabbitMQ goes offline while messages are enqueued, they will be lost!
     * @default true */
    durable?: boolean;

    /** If the queue needs to be automatically deleted when there are no consumers attached.
     * @remarks **WARNING**: RabbitMQ will delete the queue no matter the amount of messages enqueued.
     * @default false */
    autoDelete?: boolean;
  };
};

export type ConsumerChannel<T = any> = ConsumerOptions & {
  handler: {
    provider: Type<T>;
    methodName: MethodNames<T>;
  }
};

export type RabbitMQConsumerResolved = ConsumerOptions & {
  handler: IRabbitMQHandler,
}

export type ModuleOptions = {
  /** Connection URI for the RabbitMQ server
   * @example amqp://{user}:{password}@{url}/{vhost}
   * */
  connectionString?: string | string[];

  /** All exchanges declared here will be validated before attaching the consumers
   * If any of the exchanegs declared can not be asserted an error will be thrown */
  assertExchanges?: Array<Exchange>;

  /** Array of consumers that will be attached to the application*/
  consumerChannels?: Array<ConsumerChannel>;

  extraOptions?: {
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

  /** Used for multi-vhost connections. If your application needs to publish and consume from
   * different rabbit brokers or different instances, you can drop the passage of options and instead 
   * use the 
   */
  connections?: ConnectionConfig[];
};

export type ResolvedConsumerOptions = ConsumerOptions & {
  durable: boolean;
  prefetch: number;
  autoDelete: boolean;
  retryStrategy: {
    enabled: boolean;
    maxAttempts: number;
    retryFn: IRetryProgression;
  };
  dlqStrategy: {
    dlqFn: IDLQFn;
    suffix: string;
  };
};

export type MethodNames<T> = {
  // eslint-disable-next-line @typescript-eslint/ban-types
  [K in keyof T]: T[K] extends Function ? K : never;
}[keyof T] & string;

export function defineRabbitConsumer<T>(
  config: ConsumerChannel<T>
): ConsumerChannel<T> {
  return config;
}
