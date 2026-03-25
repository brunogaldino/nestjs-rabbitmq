import { Logger } from "@nestjs/common";
import { AmqpConnectionManager, ChannelWrapper } from "amqp-connection-manager";
import { ConfirmChannel, ConsumeMessage } from "amqplib";
import stringify from "faster-stable-stringify";
import { AMQPConnectionManager } from "./amqp-connection-manager";
import { merge, tryParseJson } from "./helper";
import { IRabbitMQHandler } from "./rabbitmq.interfaces";
import {
  LogType,
  RabbitMQConsumerOptions,
  RabbitMQModuleOptions,
} from "./rabbitmq.types";

type InspectInput = {
  consumeMessage: ConsumeMessage;
  data?: any;
  binding: { exchange: string; routingKey: string; queue: string };
  elapsedTime: bigint;
  error?: any;
  isDead: boolean;
};

export class RabbitMQConsumer {
  private logger: Console | Logger;

  private readonly connection: AmqpConnectionManager;
  private readonly options: RabbitMQModuleOptions;
  private readonly delayExchange: string;
  private readonly publishChannel: ChannelWrapper;
  private readonly logType: LogType;
  private defaultConsumerOptions: Partial<RabbitMQConsumerOptions> = {
    autoAck: true,
    durable: true,
    prefetch: 10,
    autoDelete: false,
    group: "rabbit-default",
    retryStrategy: {
      enabled: true,
      maxAttempts: 5,
      delay: () => 5000,
    },
    deadLetterStrategy: {
      callback: async () => true,
      suffix: ".dlq",
    },
  };

  constructor(
    connection: AmqpConnectionManager,
    options: RabbitMQModuleOptions,
    publishChannelWrapper: ChannelWrapper,
  ) {
    this.connection = connection;
    this.options = options;
    this.delayExchange = `${this.options.delayExchangeName}.delay`;
    this.publishChannel = publishChannelWrapper;

    this.logType =
      (process.env.RABBITMQ_LOG_TYPE as LogType) ??
      this.options.extraOptions.logType;

    this.logger = new Logger(RabbitMQConsumer.name);
  }

  public async createConsumer(
    consumer: RabbitMQConsumerOptions,
    messageHandler: IRabbitMQHandler,
  ): Promise<ChannelWrapper> {
    consumer = merge(this.defaultConsumerOptions, consumer);
    const consumerChannel = this.connection.createChannel({
      confirm: true,
      name: consumer.queue,
      setup: (channel: ConfirmChannel) => {
        return Promise.all([
          channel.prefetch(consumer.prefetch),
          channel.assertQueue(consumer.queue, {
            arguments: {
              'x-queue-type': 'quorum'
            },
            durable: consumer.durable,
            autoDelete: consumer.autoDelete,
            deadLetterRoutingKey: `${consumer.queue}${consumer.deadLetterStrategy?.suffix ?? ".dlq"}`,
            deadLetterExchange: "",
          }),

          new Promise((resolve) => {
            if (typeof consumer.routingKey === "object") {
              for (const rk of consumer.routingKey) {
                channel.bindQueue(consumer.queue, consumer.exchangeName, rk);
              }
            } else {
              channel.bindQueue(
                consumer.queue,
                consumer.exchangeName,
                consumer.routingKey,
              );
            }

            resolve(true);
          }),

          this.attachRetryAndDLQ(channel, consumer),

          channel.consume(consumer.queue, async (message) => {
            await this.processConsumerMessage(
              message,
              channel,
              consumer,
              messageHandler,
            );
          }),
        ]);
      },
    });

    return consumerChannel;
  }

  private async processConsumerMessage(
    message: ConsumeMessage,
    channel: ConfirmChannel,
    consumer: RabbitMQConsumerOptions,
    callback: IRabbitMQHandler,
  ): Promise<void> {
    let hasErrors = null;
    let hasRetried = false;
    const start = process.hrtime.bigint();

    try {
      await callback(tryParseJson(message.content.toString("utf8")), {
        message,
        channel,
        queue: consumer.queue,
      });
    } catch (e) {
      hasErrors = e;
      hasRetried = await this.processRetry(consumer, message, e);
    } finally {
      if (["consumer", "all"].includes(this.logType) || hasErrors)
        this.inspectConsumer({
          binding: {
            queue: consumer.queue,
            routingKey: message.fields.routingKey,
            exchange: consumer.exchangeName,
          },
          consumeMessage: message,
          error: hasErrors,
          elapsedTime: process.hrtime.bigint() - start,
          isDead: hasErrors && !hasRetried,
        });

      this.ackMessage(channel, message, consumer, hasErrors, hasRetried);
    }
  }

  private async attachRetryAndDLQ(
    channel: ConfirmChannel,
    consumer: RabbitMQConsumerOptions,
  ): Promise<void> {
    const waitQueue = `${consumer.queue}.retry`;
    const deadletterQueue = `${consumer.queue}${consumer.deadLetterStrategy?.suffix ?? ".dlq"}`;
    await channel.assertQueue(deadletterQueue, { durable: true });

    console.log(consumer?.retryStrategy?.enabled)
    if (consumer?.retryStrategy?.enabled == false) {
      return;
    }

    await channel.assertExchange(this.delayExchange, "topic", { durable: true });
    await channel.assertQueue(waitQueue, {
      durable: true,
      arguments: {
        "x-dead-letter-exchange": "",
        "x-dead-letter-routing-key": consumer.queue,
      },
    });
    await channel.bindQueue(waitQueue, this.delayExchange, consumer.queue);
  }

  private async processRetry(
    consumer: RabbitMQConsumerOptions,
    message: ConsumeMessage,
    error: Error,
  ): Promise<boolean> {
    let isPublished = false;

    if (
      consumer.retryStrategy === undefined ||
      consumer.retryStrategy.enabled === undefined ||
      consumer?.retryStrategy.enabled
    ) {
      const retryCount = message.properties?.headers?.["x-retries-count"] ?? 0;
      const maxRetry = consumer.retryStrategy.maxAttempts;

      if (retryCount < maxRetry) {
        const retryDelay = await consumer.retryStrategy.delay(tryParseJson(message.content.toString("utf8")), retryCount, error);
        if (retryDelay < 0) {
          return false;
        }

        try {
          isPublished = await this.publishChannel.publish(
            this.delayExchange,
            consumer.queue,
            stringify(tryParseJson(message.content.toString("utf8"))),
            {
              headers: {
                ...message.properties.headers,
                "x-retries-count": retryCount + 1,
              },
              expiration: retryDelay,
              deliveryMode: 2, //persistent message
              persistent: true,
            },
          );
        } catch (e) {
          this.logger.error({ message: "could_not_retry", error: e });
          isPublished = false;
        }
      }
    }

    return isPublished;
  }

  private inspectConsumer(args: InspectInput): void {
    const { binding, consumeMessage, data, error } = args;

    const { exchange, routingKey, queue } = binding;
    const { content, fields, properties } = consumeMessage;
    const message = `[AMQP] [CONSUMER] [${exchange}] [${routingKey}] [${queue}]`;
    const logLevel = error ? "error" : "log";

    const logData = {
      logLevel,
      type: "consumer",
      duration: args.elapsedTime.toString(),
      correlationId: args?.consumeMessage?.properties?.correlationId,
      binding,
      title: message,
      isDead: args.isDead,
      consumedMessage: {
        fields,
        properties,
        content: data ?? tryParseJson(content.toString("utf8")),
      },
    };

    if (error) {
      logData["error"] = {
        stack: error?.stack,
        message: error?.message,
        name: error?.name,
      };
    }

    this.logger[logLevel](logData);
  }

  private async ackMessage(
    channel: ConfirmChannel,
    message: ConsumeMessage,
    consumer: RabbitMQConsumerOptions,
    hasErrors: boolean,
    hasRetried: boolean,
  ): Promise<void> {
    if (!AMQPConnectionManager.consumerConn.isConnected()) {
      this.logger.error("Could not acknowledge message, Connection is offline");
      return;
    }

    if ((!hasErrors && consumer?.autoAck) || (hasErrors && hasRetried)) {
      channel.ack(message);
    } else if (hasErrors && !hasRetried) {
      let shouldNack = true;
      let hasError = null

      try {
        shouldNack =
          (await consumer.deadLetterStrategy?.callback?.(
            message.content.toString("utf8"),
          )) ?? true;
      } catch (e) {
        hasError = e
      } finally {
        this.logger.error({
          type: "consumer",
          title: `[AMQP] [DEADLETTER] ${message.fields.exchange} ${message.fields.routingKey} ${consumer.queue}`,
          fields: message.fields,
          error: {
            stack: hasError?.stack,
            message: hasError?.message,
            name: hasError?.name,
          },
        });
      }

      if (shouldNack) {
        channel.nack(message, false, false);
      } else {
        channel.ack(message);
      }
    }
  }
}
