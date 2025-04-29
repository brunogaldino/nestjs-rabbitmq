import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AMQPConnectionManager } from "./amqp-connection-manager";
import { LogType } from "./rabbitmq.types";
import { RabbitMQConsumer } from "./rabbitmq-consumers";
import { ChannelWrapper } from "amqp-connection-manager";
import stringify from "faster-stable-stringify";
import { PublishOptions } from "amqp-connection-manager/dist/types/ChannelWrapper";
import { merge } from "./helper";

@Injectable()
export class RabbitMQService implements OnApplicationBootstrap {
  private logType: LogType;
  private logger: Console | Logger =
    AMQPConnectionManager.rabbitModuleOptions?.extraOptions?.loggerInstance ??
    new Logger(RabbitMQService.name);

  onApplicationBootstrap() {
    this.logType =
      (process.env.RABBITMQ_LOG_TYPE as LogType) ??
      AMQPConnectionManager.rabbitModuleOptions.extraOptions.logType;
  }

  /**
   * Check status of the main conenection to the broker.
   * @returns {number} 1 - Online | 0 - Offline
   */
  public checkHealth(): number {
    return AMQPConnectionManager.consumerConn.isConnected() &&
      AMQPConnectionManager.publisherConn.isConnected()
      ? 1
      : 0;
  }

  /**
   * Publishes a message to the broker. Every published message needs its exchange and routingKey to be properly routed
   * @param {string} exchangeName - Name of the exchange
   * @param {string} routingKey - Publish routing key
   * @param {T} the message that will be published to RabbitMQ. All messages will be transformed to JSON.
   * @param {PublishOptions} options - Any custom options that you want to send with the message such as headers or properties
   * @returns {Promise<boolean>} Returns a promise of confirmation.
   * If **TRUE** it means that the message arrived and was successfully delivered to an exchange or queue.
   * If **FALSE** or an error is thrown, the message was not published !
   */
  async publish<T = any>(
    exchangeName: string,
    routingKey: string,
    message: T,
    options?: PublishOptions,
  ): Promise<boolean> {
    let hasErrors = null;
    const start = process.hrtime.bigint();
    const defaultOptions = {
      correlationId: randomUUID(),
      headers: {
        "x-application-headers": {
          "original-exchange": exchangeName,
          "original-routing-key": routingKey,
          "published-at": new Date().toISOString(),
        },
      },
      persistent: true,
      deliveryMode: 2,
    };
    const mergedOptions = merge(defaultOptions, options)
    try {
      await AMQPConnectionManager.publishChannelWrapper.publish(
        exchangeName,
        routingKey,
        stringify(message),
        mergedOptions,
      );
    } catch (e) {
      hasErrors = e;
    } finally {
      this.inspectPublisher(
        exchangeName,
        routingKey,
        message,
        process.hrtime.bigint() - start,
        mergedOptions,
        hasErrors,
      );
    }
    return !hasErrors;
  }
  /**
   * Publishes an array of messages to the broker.
   * @param {string} exchangeName - Name of the exchange
   * @param {string} routingKey - Routing key for publishing
   * @param {T[]} messages - Array of messages that will be published to RabbitMQ. All messages will be transformed into JSON.
   * @param {number} batchSize - The number of messages sent per batch,This value is used to avoid sending an excessively high number of messages at once.
   * **Default:** `100`
   * @param {PublishOptions} options - Any custom options you want to send with the message, such as headers or properties.
   * @returns {Promise<T[]>} Returns a confirmation promise.
   * If **empty**, it means all messages were successfully delivered to an exchange or queue.
   * If **contains items**, it means they **were not published**!
   */
  async publishBulk<T>(
    exchangeName: string,
    routingKey: string,
    messages: T[],
    options?: PublishOptions & { batchSize?: number }
  ): Promise<T[]> {
    const batchSize = options?.batchSize ?? 100;
    const faileds: T[] = [];
    for (let i = 0; i < messages.length; i += batchSize) {
      const chunk = messages.slice(i, i + batchSize);
      const publisheds = await Promise.allSettled(
        chunk.map(async (message: T): Promise<T | void> => {
          const published = await this.publish(
            exchangeName,
            routingKey,
            message,
            options,
          );
          if (published) return Promise.resolve();
          return Promise.reject({message});
        }),
      );
      for (const result of publisheds) {
        if (result.status === "rejected") faileds.push(result.reason.message)
      }
      if (this.checkHealth() === 0) {
        faileds.push(...messages.slice(i + batchSize));
        break;
      }
    }
    return faileds;
  }

  async createConsumers(): Promise<ChannelWrapper[]> {
    if (AMQPConnectionManager.isConsumersLoaded)
      throw new Error(
        "Consumers already initialized. If you wish to start it manually, see consumeManualLoad",
      );

    const consumerOptionList =
      AMQPConnectionManager.rabbitModuleOptions.consumerChannels ?? [];

    const consumerList = [];

    for (const consumerEntry of consumerOptionList) {
      const consumerOptions = consumerEntry.options;

      const consumer = await new RabbitMQConsumer(
        AMQPConnectionManager.consumerConn,
        AMQPConnectionManager.rabbitModuleOptions,
        AMQPConnectionManager.publishChannelWrapper,
      ).createConsumer(consumerOptions, consumerEntry.messageHandler);

      consumerList.push(consumer);
    }

    this.logger.debug("Initiating RabbitMQ consumers manually");
    AMQPConnectionManager.isConsumersLoaded = true;
    return consumerList;
  }

  private inspectPublisher(
    exchange: string,
    routingKey: string,
    content: any,
    elapsedTime: bigint,
    properties?: PublishOptions,
    error?: any,
  ): void {
    if (!["publisher", "all"].includes(this.logType) && !error) return;

    const logLevel = error ? "error" : "log";
    const logData = {
      logLevel,
      type: "publisher",
      duration: elapsedTime.toString(),
      correlationId: properties?.correlationId,
      title: `[AMQP] [PUBLISH] [${exchange}] [${routingKey}]`,
      binding: { exchange, routingKey },
      publishedMessage: {
        content,
        properties,
      },
    };

    if (error) logData["error"] = error;
    this.logger[logLevel](logData);
  }
}
