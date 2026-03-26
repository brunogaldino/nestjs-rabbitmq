import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AMQPConnectionManager } from "./amqp-connection-manager";
import stringify from "faster-stable-stringify";
import { PublishOptions } from "amqp-connection-manager/dist/types/ChannelWrapper";
import { merge } from "./helper";

@Injectable()
export class RabbitMQService {
  private logger: Logger = new Logger(RabbitMQService.name);

  constructor(private readonly AMQPConn: AMQPConnectionManager) { }

  /**
   * Check status of the main conenection to the broker.
   * @returns {number} 1 - Online | 0 - Offline
   */
  public checkHealth(): number {
    return this.AMQPConn.consumerConn?.isConnected() &&
      this.AMQPConn.publisherConn?.isConnected()
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
    const defaultHeaders = {
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

    try {
      await this.AMQPConn.publisherWrapper.publish(
        exchangeName,
        routingKey,
        stringify(message),
        merge(defaultHeaders, options),
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

  private inspectPublisher(
    exchange: string,
    routingKey: string,
    content: any,
    elapsedTime: bigint,
    properties?: PublishOptions,
    error?: any,
  ): void {
    if (!["publisher", "all"].includes(this.AMQPConn.getLogType()) && !error) return;

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
