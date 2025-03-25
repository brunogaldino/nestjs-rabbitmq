import { Logger, OnApplicationBootstrap } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AMQPConnectionManager } from "./amqp-connection-manager";
import { LogType } from "./rabbitmq.types";
import { RabbitMQConsumer } from "./rabbitmq-consumers";
import { ChannelWrapper } from "amqp-connection-manager";
import stringify from "faster-stable-stringify";
import { PublishOptions } from "amqp-connection-manager/dist/types/ChannelWrapper";

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

    try {
      await AMQPConnectionManager.publishChannelWrapper.publish(
        exchangeName,
        routingKey,
        stringify(message),
        {
          correlationId: randomUUID(),
          headers: {
            "x-application-headers": {
              "original-exchange": exchangeName,
              "original-routing-key": routingKey,
              "published-at": new Date().toISOString(),
            },
          },
          ...options,
          persistent: true,
          deliveryMode: 2,
        },
      );
    } catch (e) {
      hasErrors = e;
    } finally {
      this.inspectPublisher(
        exchangeName,
        routingKey,
        message,
        process.hrtime.bigint() - start,
        options,
        hasErrors,
      );
    }

    return !hasErrors;
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

    //TODO: Check if I need stringify
    this.logger[logLevel](logData);
  }
}
