import { Logger } from "@nestjs/common";
import { AmqpConnectionManager, ChannelWrapper } from "amqp-connection-manager";
import { ConfirmChannel, ConsumeMessage } from "amqplib";
import stringify from "faster-stable-stringify";
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

type ResolvedConsumerOptions = RabbitMQConsumerOptions & {
  autoAck: boolean;
  durable: boolean;
  prefetch: number;
  autoDelete: boolean;
  group: string;
  retryStrategy: Required<NonNullable<RabbitMQConsumerOptions["retryStrategy"]>>;
  deadLetterStrategy: Required<NonNullable<RabbitMQConsumerOptions["deadLetterStrategy"]>>;
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
    this.logType = this.options.extraOptions.logType;

    this.logger = new Logger(RabbitMQConsumer.name);
  }

  public async createConsumer(
    consumer: RabbitMQConsumerOptions,
    messageHandler: IRabbitMQHandler,
  ): Promise<ChannelWrapper> {
    const resolved = merge(this.defaultConsumerOptions, consumer) as ResolvedConsumerOptions;
    const consumerChannel = this.connection.createChannel({
      confirm: true,
      name: resolved.queue,
      setup: (channel: ConfirmChannel) => {
        return Promise.all([
          channel.prefetch(resolved.prefetch),
          channel.assertQueue(resolved.queue, {
            arguments: {
              'x-queue-type': 'quorum'
            },
            durable: resolved.durable,
            autoDelete: resolved.autoDelete,
            deadLetterRoutingKey: `${resolved.queue}${resolved.deadLetterStrategy.suffix}`,
            deadLetterExchange: "",
          }),

          new Promise((resolve) => {
            if (typeof resolved.routingKey === "object") {
              for (const rk of resolved.routingKey) {
                channel.bindQueue(resolved.queue, resolved.exchangeName, rk);
              }
            } else {
              channel.bindQueue(
                resolved.queue,
                resolved.exchangeName,
                resolved.routingKey,
              );
            }

            resolve(true);
          }),

          this.attachRetryAndDLQ(channel, resolved),

          channel.consume(resolved.queue, async (message) => {
            await this.processConsumerMessage(
              message,
              channel,
              resolved,
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
    consumer: ResolvedConsumerOptions,
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
    consumer: ResolvedConsumerOptions,
  ): Promise<void> {
    const waitQueue = `${consumer.queue}.retry`;
    const deadletterQueue = `${consumer.queue}${consumer.deadLetterStrategy.suffix}`;
    await channel.assertQueue(deadletterQueue, {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
      },
    });

    if (!consumer.retryStrategy.enabled) {
      return;
    }

    await channel.assertExchange(this.delayExchange, "topic", { durable: true });
    await channel.assertQueue(waitQueue, {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        "x-dead-letter-exchange": "",
        "x-dead-letter-routing-key": consumer.queue,
      },
    });
    await channel.bindQueue(waitQueue, this.delayExchange, consumer.queue);
  }

  private async processRetry(
    consumer: ResolvedConsumerOptions,
    message: ConsumeMessage,
    error: Error,
  ): Promise<boolean> {
    if (!consumer.retryStrategy.enabled) {
      return false;
    }

    const retryCount = message.properties.headers?.["x-retries-count"] ?? 0;
    const maxRetry = consumer.retryStrategy.maxAttempts;
    const originalRoutingKey =
      message.properties.headers?.["x-original-routing-key"] ??
      message.fields.routingKey;

    if (retryCount >= maxRetry) {
      return false;
    }

    const retryDelay = await consumer.retryStrategy.delay(
      tryParseJson(message.content.toString("utf8")),
      retryCount,
      error,
    );

    if (retryDelay < 0) {
      return false;
    }

    try {
      return await this.publishChannel.publish(
        this.delayExchange,
        consumer.queue,
        stringify(tryParseJson(message.content.toString("utf8"))),
        {
          headers: {
            ...message.properties.headers,
            "x-retries-count": retryCount + 1,
            "x-original-routing-key": originalRoutingKey,
          },
          expiration: retryDelay,
          deliveryMode: 2,
          persistent: true,
        },
      );
    } catch (e) {
      this.logger.error({ message: "could_not_retry", error: e });
      return false;
    }
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
      correlationId: args.consumeMessage.properties.correlationId,
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
    consumer: ResolvedConsumerOptions,
    hasErrors: boolean,
    hasRetried: boolean,
  ): Promise<void> {
    if (!this.connection.isConnected()) {
      this.logger.error("Could not acknowledge message, Connection is offline");
      return;
    }

    if ((!hasErrors && consumer.autoAck) || (hasErrors && hasRetried)) {
      channel.ack(message);
    } else if (hasErrors && !hasRetried) {
      let shouldNack = true;
      let hasError = null

      try {
        shouldNack =
          (await consumer.deadLetterStrategy.callback(
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
