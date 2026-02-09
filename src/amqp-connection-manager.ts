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
import { RabbitOptionsFactory } from "./rabbitmq.interfaces";
import {
  ConnectionType,
  RabbitMQConsumerChannel,
  RabbitMQModuleOptions,
} from "./rabbitmq.types";
import { merge } from "./helper";

@Injectable()
export class AMQPConnectionManager
  implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown {
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
      heartbeatIntervalInSeconds: 0,
      reconnectTimeInSeconds: 5,
    },
  };
  public static rabbitModuleOptions: RabbitMQModuleOptions;
  public static publishChannelWrapper: ChannelWrapper = null;
  public static consumerConn: AmqpConnectionManager;
  public static publisherConn: AmqpConnectionManager;
  public static isConsumersLoaded: boolean = false;
  private connectionBlockedReason: string;
  private consumers: ChannelWrapper[] = [];

  constructor(@Inject("RABBIT_OPTIONS") options: RabbitOptionsFactory) {
    AMQPConnectionManager.rabbitModuleOptions = merge(
      this.defaultOptions,
      options.createRabbitOptions(),
    );

    this.logger =
      AMQPConnectionManager.rabbitModuleOptions.extraOptions?.loggerInstance ??
      new Logger(AMQPConnectionManager.name);
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
    await AMQPConnectionManager?.consumerConn?.close();
    await AMQPConnectionManager?.publisherConn?.close();
  }

  public getConsumers() {
    return this.consumers;
  }

  private async connect() {
    const params = {
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
          connection_name: `${process.env?.npm_package_name ?? process.env.SERVICE_NAME}-${hostname()}-consumer`,
        },
      },
    };

    await new Promise((resolve) => {
      AMQPConnectionManager.consumerConn = connect(
        AMQPConnectionManager.rabbitModuleOptions.connectionString,
        {
          ...params,
          connectionOptions: {
            clientProperties: {
              connection_name: `${process.env?.npm_package_name ?? process.env.SERVICE_NAME}-${hostname()}-consumer`,
            },
          },
        },
      );

      this.attachEvents("consumer", resolve);
    });

    await new Promise((resolve) => {
      AMQPConnectionManager.publisherConn = connect(
        AMQPConnectionManager.rabbitModuleOptions.connectionString,
        {
          ...params,
          connectionOptions: {
            clientProperties: {
              connection_name: `${process.env?.npm_package_name ?? process.env.SERVICE_NAME}-${hostname()}-publisher`,
            },
          },
        },
      );

      this.attachEvents("publisher", resolve);
    });

    await this.assertExchanges();
  }

  private attachEvents(type: ConnectionType, resolve: any) {
    const conn = this.getConnection(type);

    conn.on("connect", async ({ url }: { url: string }) => {
      this.logger.log(
        `Rabbit ${type} connected to ${url.replace(
          new RegExp(url.replace(/amqp:\/\/[^:]*:([^@]*)@.*?$/i, "$1"), "g"),
          "***",
        )}`,
      );
      resolve(true);
    });

    conn.on("disconnect", ({ err }) => {
      this.logger.warn(`Disconnected from rabbitmq: ${err.message}`);

      if (
        this.rabbitTerminalErrors.some((errorMessage) =>
          err.message.toLowerCase().includes(errorMessage),
        )
      ) {
        conn.close();

        this.logger.error({
          message: `RabbitMQ Disconnected with a terminal error, impossible to reconnect `,
          error: err,
          x: err.message,
        });
      }
    });

    conn.on("connectFailed", ({ err }) => {
      this.logger.error(
        `Failure to connect to RabbitMQ instance: ${err.message}`,
      );
    });

    if (type === "publisher") {
      conn.on("blocked", ({ reason }) => {
        this.logger.error(`RabbitMQ broker is blocked with reason: ${reason}`);
        this.connectionBlockedReason = reason;
      });

      conn.on("unblocked", () => {
        this.logger.error(
          `RabbitMQ broker connection is unblocked, last reason was: ${this.connectionBlockedReason}`,
        );
      });
    }
  }

  public getConnection(type: ConnectionType) {
    if (type === "publisher") {
      return AMQPConnectionManager.publisherConn;
    } else {
      return AMQPConnectionManager.consumerConn;
    }
  }

  private async assertExchanges(): Promise<void> {
    await new Promise((resolve) => {
      AMQPConnectionManager.publishChannelWrapper = this.getConnection(
        "publisher",
      ).createChannel({
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

      this.consumers.push(
        await new RabbitMQConsumer(
          AMQPConnectionManager.consumerConn,
          AMQPConnectionManager.rabbitModuleOptions,
          AMQPConnectionManager.publishChannelWrapper,
        ).createConsumer(consumer, consumerEntry.messageHandler),
      );
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
