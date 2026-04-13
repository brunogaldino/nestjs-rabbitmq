import { Logger } from "@nestjs/common";
import { ChannelWrapper } from "amqp-connection-manager";
import { ConsumeMessage } from "amqplib";
import { ResolvedConsumerOptions } from "./rabbitmq.types";
import { tryParseJson } from "./helper";
import stringify from "faster-stable-stringify";

export class RetryHandler {
  private logger = new Logger(RetryHandler.name)

  constructor(
    private readonly publishChannel: ChannelWrapper,
  ) { }

  async execute(
    consumer: ResolvedConsumerOptions,
    message: ConsumeMessage,
    error: Error,
  ): Promise<boolean> {
    if (!consumer.retryStrategy.enabled) {
      return false;
    }

    const retryCount = message.properties.headers?.["x-retries-count"] ?? 1;
    const maxRetry = consumer.retryStrategy.maxAttempts;
    const originalRoutingKey =
      message.properties.headers?.["x-original-routing-key"] ??
      message.fields.routingKey;

    if (retryCount > maxRetry) {
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

    const retryQueue = `${consumer.queue}.retry`;
    try {
      return await this.publishChannel.publish(
        "",
        retryQueue,
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
}
