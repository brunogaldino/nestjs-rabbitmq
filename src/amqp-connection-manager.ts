import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  OnModuleInit,
} from "@nestjs/common";
import {
  AmqpConnectionManager,
  ChannelWrapper,
  connect,
} from "amqp-connection-manager";
import { ConfirmChannel } from "amqplib";
import { hostname } from "node:os";
import { RabbitMQConsumer } from "./rabbitmq-consumers";
import { IRabbitHandler, RabbitOptionsFactory } from "./rabbitmq.interfaces";
import {
  RabbitMQConsumerChannel,
  RabbitMQConsumerOptions,
  RabbitMQModuleOptions,
} from "./rabbitmq.types";

@Injectable()
export class AMQPConnectionManager
  implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger: Console | Logger;
  private rabbitTerminalErrors: string[] = [
    "channel-error",
    "precondition-failed",
    "not-allowed",
    "access-refused",
    "closed via management plugin",
  ];

  private defaultOptions: Partial<RabbitMQModuleOptions> = {
    extraOptions: {
      logType: "none",
      consumerManualLoad: false,
      heartbeatIntervalInSeconds: 5,
      reconnectTimeInSeconds: 5,
    },
  };
  public static rabbitModuleOptions: RabbitMQModuleOptions;
  public static publishChannelWrapper: ChannelWrapper = null;
  public static connection: AmqpConnectionManager;
  public static isConsumersLoaded: boolean = false;
  public static errorMessage = null;
  public static consumers: Map<
    string,
    {
      options: RabbitMQConsumerOptions;
      channel: ChannelWrapper;
      callback: IRabbitHandler;
    }
  > = new Map();
  private static routingKeyList: string[] = [];
  private connectionBlockedReason: string;

  constructor(@Inject("RABBIT_OPTIONS") options: RabbitOptionsFactory) {
    this.logger =
      options.createRabbitOptions()?.extraOptions?.loggerInstance ??
      new Logger(AMQPConnectionManager.name);
    AMQPConnectionManager.rabbitModuleOptions = {
      ...this.defaultOptions,
      ...options.createRabbitOptions(),
    };
  }

  async onModuleInit() {
    return this.connect();
  }

  async onApplicationBootstrap() {
    if (
      AMQPConnectionManager.rabbitModuleOptions.extraOptions.consumerManualLoad
    )
      return;
    await this.createConsumers();

    this.logger.debug("Initiating RabbitMQ consumers automatically");
  }

  async onApplicationShutdown() {
    this.logger.log("Closing RabbitMQ Connection");
    await AMQPConnectionManager?.connection?.close();
  }

  private async connect() {
    await new Promise((resolve) => {
      AMQPConnectionManager.connection = connect(
        AMQPConnectionManager.rabbitModuleOptions.connectionString,
        {
          heartbeatIntervalInSeconds:
            AMQPConnectionManager.rabbitModuleOptions.extraOptions
              .heartbeatIntervalInSeconds,
          reconnectTimeInSeconds:
            AMQPConnectionManager.rabbitModuleOptions.extraOptions
              .reconnectTimeInSeconds,
          connectionOptions: {
            keepAlive: true,
            keepAliveDelay: 5000,
            servername: hostname(),
            clientProperties: {
              connection_name: `${process.env.npm_package_name}-${hostname()}`,
            },
          },
        },
      );

      this.attachEvents(resolve);
    });

    await this.assertExchanges();
  }

  private attachEvents(resolve: any) {
    this.getConnection().on("connect", async ({ url }: { url: string }) => {
      this.logger.log(
        `Rabbit connected to ${url.replace(
          new RegExp(url.replace(/amqp:\/\/[^:]*:([^@]*)@.*?$/i, "$1"), "g"),
          "***",
        )}`,
      );
      resolve(true);
    });

    this.getConnection().on("disconnect", ({ err }) => {
      this.logger.warn(`Disconnected from rabbitmq: ${err.message}`);

      if (
        this.rabbitTerminalErrors.some((errorMessage) =>
          err.message.toLowerCase().includes(errorMessage),
        )
      ) {
        this.getConnection().close();

        this.logger.error({
          message: `RabbitMQ Disconnected with a terminal error, impossible to reconnect `,
          error: err,
          x: err.message,
        });
      }
    });

    this.getConnection().on("connectFailed", ({ err }) => {
      this.logger.error(
        `Failure to connect to RabbitMQ instance: ${err.message}`,
      );
    });

    this.getConnection().on("blocked", ({ reason }) => {
      this.logger.error(`RabbitMQ broker is blocked with reason: ${reason}`);
      this.connectionBlockedReason = reason;
    });

    this.getConnection().on("unblocked", () => {
      this.logger.error(
        `RabbitMQ broker connection is unblocked, last reason was: ${this.connectionBlockedReason}`,
      );
    });
  }

  private getConnection() {
    return AMQPConnectionManager.connection;
  }

  private async assertExchanges(): Promise<void> {
    await new Promise((resolve) => {
      AMQPConnectionManager.publishChannelWrapper =
        this.getConnection().createChannel({
          name: `${process.env.npm_package_name}_publish`,
          confirm: true,
          publishTimeout: 60000,
        });

      AMQPConnectionManager.publishChannelWrapper.on("connect", () => {
        this.logger.debug("Initiating RabbitMQ producers");
        resolve(true);
      });

      AMQPConnectionManager.publishChannelWrapper.on("close", () => {
        this.logger.debug("Closing RabbitMQ producer channel");
      });

      AMQPConnectionManager.publishChannelWrapper.on("error", (err, info) => {
        this.logger.error("Cannot open publish channel", err, info);
      });
    });

    for (const publisher of AMQPConnectionManager.rabbitModuleOptions
      ?.assertExchanges ?? []) {
      await AMQPConnectionManager.publishChannelWrapper.addSetup(
        async (channel: ConfirmChannel) => {
          const isDelayed = publisher.options?.isDelayed ?? false;
          const type = isDelayed ? "x-delayed-message" : publisher.type;
          const argument = isDelayed
            ? { arguments: { "x-delayed-type": publisher.type } }
            : null;

          await channel.assertExchange(publisher.name, type, {
            durable: publisher?.options?.durable ?? true,
            autoDelete: publisher?.options?.autoDelete ?? false,
            ...argument,
          });
        },
      );
    }
  }

  private async createConsumers(): Promise<void> {
    const consumerList =
      AMQPConnectionManager.rabbitModuleOptions.consumerChannels ?? [];

    this.checkDuplicatedQueues(consumerList);

    for (const consumerEntry of consumerList) {
      const consumer = consumerEntry.options;

      await new RabbitMQConsumer(
        AMQPConnectionManager.connection,
        AMQPConnectionManager.rabbitModuleOptions,
        AMQPConnectionManager.publishChannelWrapper,
      ).createConsumer(consumer, consumerEntry.messageHandler);
    }

    AMQPConnectionManager.isConsumersLoaded = true;
  }

  private checkDuplicatedQueues(consumerList: RabbitMQConsumerChannel[]): void {
    const queueNameList = [];
    consumerList.map((curr) => queueNameList.push(curr.options.queue));
    const dedupList = new Set(queueNameList);

    if (dedupList.size != queueNameList.length) {
      this.logger.error({
        error: "duplicated_queues",
        description: "Cannot have multiple queues on different binds",
        queues: Array.from(
          new Set(
            queueNameList.filter(
              (value, index) => queueNameList.indexOf(value) != index,
            ),
          ),
        ),
      });

      process.exit(-1);
    }
  }
}
