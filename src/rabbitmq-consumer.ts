import { Logger } from "@nestjs/common";
import { AmqpConnectionManager, ChannelWrapper } from "amqp-connection-manager";
import { ConfirmChannel, ConsumeMessage } from "amqplib";
import { generateRandomChars, tryParseJson } from "./helper";
import { IDLQFn, IRabbitMQHandler, IRetryProgression } from "./rabbitmq.interfaces";
import {
  LogType,
  ConsumerOptions,
  ResolvedConsumerOptions,
} from "./rabbitmq.types";
import { RetryHandler } from "./rabbitmq-retry-handler";
import { hostname } from "node:os";

type InspectInput = {
  consumeMessage: ConsumeMessage;
  data?: any;
  binding: { exchange: string; routingKey: string; queue: string };
  elapsedTime: bigint;
  error?: any;
  isDead: boolean;
};


export function resolveConsumerOptions(
  consumer: ConsumerOptions,
  defaults: { defaultMaxRetry: number },
): ResolvedConsumerOptions {
  return {
    ...consumer,
    durable: consumer.durable ?? true,
    prefetch: consumer.prefetch ?? 10,
    autoDelete: consumer.autoDelete ?? false,
    retryStrategy: {
      enabled: consumer.retryStrategy?.enabled ?? true,
      maxAttempts: consumer.retryStrategy?.maxAttempts ?? defaults.defaultMaxRetry,
      // retryFn/dlqFn given as strings are resolved to bound methods at discovery time
      retryFn: (consumer.retryStrategy?.retryFn as IRetryProgression) ?? (() => 5000),
    },
    dlqStrategy: {
      dlqFn: (consumer.dlqStrategy?.dlqFn as IDLQFn) ?? (async () => true),
      suffix: consumer.dlqStrategy?.suffix ?? ".dlq",
    },
  };
}

export class RabbitMQConsumer {
  private logger = new Logger(RabbitMQConsumer.name);

  private readonly connection: AmqpConnectionManager;
  private readonly logType: LogType;
  private readonly defaultMaxRetry: number;
  private readonly retryHandler: RetryHandler;

  constructor(
    connection: AmqpConnectionManager,
    logType: LogType,
    publishChannelWrapper: ChannelWrapper,
    defaultMaxRetry = 5,
  ) {
    this.connection = connection;
    this.logType = logType;
    this.defaultMaxRetry = defaultMaxRetry;
    this.retryHandler = new RetryHandler(publishChannelWrapper)
  }

  public async createConsumer(
    consumer: ConsumerOptions,
    handler: IRabbitMQHandler,
  ): Promise<ChannelWrapper> {
    const resolved = resolveConsumerOptions(consumer, {
      defaultMaxRetry: this.defaultMaxRetry,
    });
    const consumerChannel = this.connection.createChannel({
      confirm: true,
      name: resolved.queue,
      setup: (channel: ConfirmChannel) => this.setupChannel(channel, resolved, handler)
    });

    return consumerChannel;
  }

  private async setupChannel(channel: ConfirmChannel, consumer: ResolvedConsumerOptions, handler: IRabbitMQHandler): Promise<void> {
    await channel.prefetch(consumer.prefetch)

    await channel.assertQueue(consumer.queue, {
      arguments: {
        'x-queue-type': 'quorum'
      },
      durable: consumer.durable,
      autoDelete: consumer.autoDelete,
      deadLetterRoutingKey: `${consumer.queue}${consumer.dlqStrategy.suffix}`,
      deadLetterExchange: "",
    })

    await this.bindRoutingKeys(channel, consumer);
    await this.attachRetryAndDLQ(channel, consumer);
    channel.consume(consumer.queue, async (message) =>
      await this.consume(
        message,
        channel,
        consumer,
        handler,
      ), {
      consumerTag: `${hostname()}:${generateRandomChars(8)}`
    }
    )
  }

  private async bindRoutingKeys(channel: ConfirmChannel, consumer: ResolvedConsumerOptions): Promise<void> {
    const keys = Array.isArray(consumer.routingKey) ? consumer.routingKey : [consumer.routingKey];

    for (const rk of keys) {
      await channel.bindQueue(consumer.queue, consumer.exchangeName, rk);
    }
  }

  private async attachRetryAndDLQ(
    channel: ConfirmChannel,
    consumer: ResolvedConsumerOptions,
  ): Promise<void> {
    const waitQueue = `${consumer.queue}.retry`;
    const deadletterQueue = `${consumer.queue}${consumer.dlqStrategy.suffix}`;
    await channel.assertQueue(deadletterQueue, {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
      },
    });

    if (!consumer.retryStrategy.enabled) {
      return;
    }

    await channel.assertQueue(waitQueue, {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        "x-dead-letter-exchange": "",
        "x-dead-letter-routing-key": consumer.queue,
      },
    });
  }

  private async consume(
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
        queue: consumer.queue,
        originalRoutingKey: message.properties.headers["x-original-routing-key"] ?? message.fields.routingKey ?? null
      });
    } catch (e) {
      hasErrors = e;
      hasRetried = await this.retryHandler.execute(consumer, message, e);
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

    if (!hasErrors || (hasErrors && hasRetried)) {
      channel.ack(message);
    } else if (hasErrors && !hasRetried) {
      let shouldNack = true;

      try {
        shouldNack =
          (await consumer.dlqStrategy.dlqFn(
            message.content.toString("utf8"),
          )) ?? true;
      } catch (e) {
        this.logger.error({
          type: "consumer",
          title: `[AMQP] [DEADLETTER] ${message.fields.exchange} ${message.fields.routingKey} ${consumer.queue}`,
          fields: message.fields,
          error: {
            stack: e?.stack,
            message: e?.message,
            name: e?.name,
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
}
