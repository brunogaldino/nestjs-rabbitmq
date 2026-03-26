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
import { merge } from "./helper";
import { RabbitMQConsumer } from "./rabbitmq-consumer";
import {
  ConnectionType,
  RabbitMQModuleOptions,
} from "./rabbitmq.types";
import { ModuleRef } from "@nestjs/core";
import { LogType } from "./rabbitmq.types";
import { RABBIT_OPTIONS } from "./rabbitmq.constants";

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
  private opts: RabbitMQModuleOptions;
  public publisherWrapper: ChannelWrapper = null;
  public consumerConn: AmqpConnectionManager;
  public publisherConn: AmqpConnectionManager;
  private connectionBlockedReason: string;

  constructor(
    @Inject(RABBIT_OPTIONS) options: RabbitMQModuleOptions,
    private readonly moduleRef: ModuleRef,
    // private readonly discoveryService: DiscoveryService,
    // private readonly metadataScanner: MetadataScanner,
    // private readonly reflector: Reflector
  ) {
    this.opts = merge(
      this.defaultOptions,
      options
    );

    this.opts.extraOptions.logType = process.env?.RABBITMQ_LOG_TYPE as LogType ?? this.opts.extraOptions.logType;
    this.logger = new Logger(AMQPConnectionManager.name);
  }

  async onModuleInit() {
    return this.connect();
  }

  async onApplicationBootstrap() {
    if (
      this.opts.extraOptions.consumerManualLoad
    )
      return;
    await this.createConsumers();

    this.logger.debug("Initiating RabbitMQ consumers automatically");
  }

  getLogType(): LogType {
    return this.opts.extraOptions.logType;
  }

  public async createConsumers(group?: string): Promise<void> {
    const consumerList =
      this.opts.consumerChannels ?? [];
    const consumerGroup = process.env?.RMQ_CONSUMER_GROUP?.toLocaleLowerCase()?.trim() ?? group ?? "rabbit-default"

    if (consumerGroup !== "rabbit-default") {
      this.logger.log(`Initializing consumers with group: ${consumerGroup}`)
    } else {
      this.logger.log(`No groups associated, initializing all consumers without groups`)
    }

    for (const consumer of consumerList) {
      consumer.group = consumer?.group ?? consumerGroup
      if (consumer.group !== consumerGroup) {
        continue;
      }

      if (consumer.enabled === false) {
        this.logger.debug({
          type: "initialization",
          title: `[AMQP] [INIT] Consumer ${consumer.queue} is DISABLED`,
        })
        continue;
      }

      const instance = this.moduleRef.get(consumer.handler.provider, { strict: false });
      const handler = instance[consumer.handler.methodName]

      if (typeof handler !== 'function') {
        throw new Error(`RabbitMQModule: Method ${consumer.handler.methodName} not found on ${instance.constructor.name}`);
      }

      await this.buildConsumer().createConsumer(consumer, handler.bind(instance))

      this.logger.debug({
        type: "initialization",
        title: `[AMQP] [INIT] Initializing consumer ${consumer.queue}`,
        binding: { exchange: consumer.exchangeName, routingKey: consumer.routingKey, group: consumer.group },
      })
    }
  }

  // private async discoverDecorators() {
  //   const providers = this.discoveryService.getProviders()
  //
  //   for (const wrapper of providers) {
  //     const { instance } = wrapper
  //     if (!instance || !Object.getPrototypeOf(instance)) return;
  //
  //     const methods = this.metadataScanner.getAllMethodNames(instance)
  //
  //     for (const method of methods) {
  //       const metadata = this.reflector.get(RABBIT_HANDLER_METADATA, instance[method]) as RabbitMQConsumerOptions
  //
  //       if (metadata) {
  //         const handler = instance[method].bind(instance)
  //
  //         await new RabbitMQConsumer(
  //           AMQPConnectionManager.consumerConn,
  //           this.rabbitModuleOptions,
  //           AMQPConnectionManager.publishChannelWrapper,
  //         ).createConsumer(metadata, handler.bind(instance))
  //       }
  //     }
  //   }
  // }

  async onApplicationShutdown() {
    this.logger.log("Closing RabbitMQ Connection");
    await this.consumerConn?.close();
    await this.publisherConn?.close();
  }

  private async connectBroker(type: ConnectionType): Promise<AmqpConnectionManager> {
    const conn = connect(this.opts.connectionString, this.buildConnectionOptions(type));

    await new Promise<void>((resolve) => {
      this.attachEvents(conn, type, resolve);
    });

    return conn;
  }

  private buildConnectionOptions(suffix: string) {
    return {
      heartbeatIntervalInSeconds: this.opts.extraOptions.heartbeatIntervalInSeconds,
      reconnectTimeInSeconds: this.opts.extraOptions.reconnectTimeInSeconds,
      connectionOptions: {
        keepAlive: true,
        keepAliveDelay: 5000,
        servername: hostname(),
        clientProperties: {
          connection_name: `${process.env.PROJECT_NAME}-${hostname()}-${suffix}`
        },
      },
    };
  }

  private async connect() {
    this.consumerConn = await this.connectBroker("consumer");
    this.publisherConn = await this.connectBroker("publisher");


    await this.assertExchanges();
  }

  private attachEvents(conn: AmqpConnectionManager, type: ConnectionType, resolve: any) {
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
        this.logger.log(
          `RabbitMQ broker connection is unblocked, last reason was: ${this.connectionBlockedReason}`,
        );
      });
    }
  }

  private getConnection(type: ConnectionType) {
    if (type === "publisher") {
      return this.publisherConn;
    } else {
      return this.consumerConn;
    }
  }

  private async assertExchanges(): Promise<void> {
    await new Promise((resolve) => {
      this.publisherWrapper = this.getConnection(
        "publisher",
      ).createChannel({
        name: `${process.env.PROJECT_NAME}_publish`,
        confirm: true,
        publishTimeout: 60000,
      });

      this.publisherWrapper.on("connect", () => {
        this.logger.debug("Initiating RabbitMQ producers");
        resolve(true);
      });

      this.publisherWrapper.on("close", () => {
        this.logger.debug("Closing RabbitMQ producer channel");
      });

      this.publisherWrapper.on("error", (err, info) => {
        this.logger.error("Cannot open publish channel", err, info);
      });
    });

    for (const publisher of this.opts
      ?.assertExchanges ?? []) {
      await this.publisherWrapper.addSetup(
        async (channel: ConfirmChannel) => {
          await channel.assertExchange(publisher.name, publisher.type, {
            durable: publisher?.options?.durable ?? true,
            autoDelete: publisher?.options?.autoDelete ?? false,
          });
        },
      );
    }
  }

  private buildConsumer(): RabbitMQConsumer {
    return new RabbitMQConsumer(this.consumerConn, this.opts, this.publisherWrapper);
  }
}
