import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AMQPConnectionManager } from "./amqp-connection-manager";
import stringify from "faster-stable-stringify";
import { PublishOptions } from "amqp-connection-manager/dist/types/ChannelWrapper";
import { merge, extractTraceContext } from "./helper";

@Injectable()
export class RabbitMQService {
  private logger: Logger = new Logger(RabbitMQService.name);

  constructor(private readonly AMQPConn: AMQPConnectionManager) { }

  /**
   * Check status of broker connections.
   * When called without arguments, checks all connections.
   * When called with a connection name, checks only that connection.
   * @returns {number} 1 - Online | 0 - Offline
   */
  public async checkHealth(connectionName?: string): Promise<number> {
    await this.AMQPConn.ensureConnected();

    if (connectionName) {
      const holder = this.AMQPConn.getConnectionHolder(connectionName);
      const publisherOk = holder.publisherConn?.isConnected();
      const consumerOk = holder.consumerConn ? holder.consumerConn.isConnected() : true;
      return publisherOk && consumerOk ? 1 : 0;
    }

    for (const holder of this.AMQPConn.getAllConnections()) {
      const publisherOk = holder.publisherConn?.isConnected();
      const consumerOk = holder.consumerConn ? holder.consumerConn.isConnected() : true;
      if (!publisherOk || !consumerOk) return 0;
    }
    return 1;
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
    options?: PublishOptions & { connection?: string },
  ): Promise<boolean> {
    let hasErrors = null;
    const start = process.hrtime.bigint();
    const correlationId = options?.correlationId ?? randomUUID();
    const defaultHeaders = {
      correlationId,
      headers: {
        "x-correlation-id": correlationId,
        "x-original-exchange": exchangeName,
        "x-original-routing-key": routingKey,
        "x-published-at": new Date().toISOString(),
      },
      persistent: true,
      deliveryMode: 2,
    };

    let effectiveOptions: PublishOptions = defaultHeaders;

    try {
      await this.AMQPConn.ensureConnected();
      const connectionName = options?.connection ?? "default";
      const holder = this.AMQPConn.getConnectionHolder(connectionName);
      const { connection: _conn, ...publishOptions } = options ?? {};
      effectiveOptions = merge(defaultHeaders, publishOptions);

      await holder.publisherWrapper.publish(
        exchangeName,
        routingKey,
        stringify(message),
        effectiveOptions,
      );
    } catch (e) {
      hasErrors = e;
    } finally {
      this.inspectPublisher(
        exchangeName,
        routingKey,
        message,
        process.hrtime.bigint() - start,
        effectiveOptions,
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
    const headerContext = extractTraceContext(properties?.headers);
    const logData = {
      logLevel,
      type: "publisher",
      duration: elapsedTime.toString(),
      correlationId: properties?.correlationId ?? headerContext.correlationId,
      ...(headerContext.traceContext && { traceContext: headerContext.traceContext }),
      ...(headerContext.publishedAt && { publishedAt: headerContext.publishedAt }),
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
