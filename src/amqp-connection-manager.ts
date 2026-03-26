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
import { RabbitMQConsumer } from "./rabbitmq-consumers";
import {
  ConnectionType,
  RabbitMQModuleOptions,
} from "./rabbitmq.types";
import { DiscoveryService, MetadataScanner, ModuleRef, Reflector } from "@nestjs/core";
import { RABBIT_HANDLER_METADATA } from "./rabbit-consumer.decorator";
import { RabbitMQConsumerOptions } from "dist";

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
  private rabbitModuleOptions: RabbitMQModuleOptions;
  private connectionBlockedReason: string;

  public static publishChannelWrapper: ChannelWrapper = null;
  public static consumerConn: AmqpConnectionManager;
  public static publisherConn: AmqpConnectionManager;

  constructor(
    @Inject("RABBIT_OPTIONS") options: RabbitMQModuleOptions,
    private readonly moduleRef: ModuleRef,
    private readonly discoveryService: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
    private readonly reflector: Reflector
  ) {
    this.rabbitModuleOptions = merge(
      this.defaultOptions,
      options
    );

    process.env.RABBITMQ_LOG_TYPE = this.rabbitModuleOptions.extraOptions.logType;
    this.logger = new Logger(AMQPConnectionManager.name);
  }

  async onModuleInit() {
    return this.connect();
  }

  async onApplicationBootstrap() {
    if (
      this.rabbitModuleOptions.extraOptions.consumerManualLoad
    )
      return;
    await this.createConsumers();

    this.logger.debug("Initiating RabbitMQ consumers automatically");
  }

  private async discoverDecorators() {
    const providers = this.discoveryService.getProviders()

    for (const wrapper of providers) {
      const { instance } = wrapper
      if (!instance || !Object.getPrototypeOf(instance)) return;

      const methods = this.metadataScanner.getAllMethodNames(instance)

      for (const method of methods) {
        const metadata = this.reflector.get(RABBIT_HANDLER_METADATA, instance[method]) as RabbitMQConsumerOptions

        if (metadata) {
          const handler = instance[method].bind(instance)

          await new RabbitMQConsumer(
            AMQPConnectionManager.consumerConn,
            this.rabbitModuleOptions,
            AMQPConnectionManager.publishChannelWrapper,
          ).createConsumer(metadata, handler.bind(instance))
        }
      }
    }
  }

  async onApplicationShutdown() {
    this.logger.log("Closing RabbitMQ Connection");
    await AMQPConnectionManager?.consumerConn?.close();
    await AMQPConnectionManager?.publisherConn?.close();
  }

  private async connect() {
    const params = {
      heartbeatIntervalInSeconds:
        this.rabbitModuleOptions.extraOptions
          .heartbeatIntervalInSeconds,
      reconnectTimeInSeconds:
        this.rabbitModuleOptions.extraOptions
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
        this.rabbitModuleOptions.connectionString,
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
        this.rabbitModuleOptions.connectionString,
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

  private getConnection(type: ConnectionType) {
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

    for (const publisher of this.rabbitModuleOptions
      ?.assertExchanges ?? []) {
      await AMQPConnectionManager.publishChannelWrapper.addSetup(
        async (channel: ConfirmChannel) => {
          await channel.assertExchange(publisher.name, publisher.type, {
            durable: publisher?.options?.durable ?? true,
            autoDelete: publisher?.options?.autoDelete ?? false,
          });
        },
      );
    }
  }

  public async createConsumers(group?: string): Promise<void> {
    const consumerList =
      this.rabbitModuleOptions.consumerChannels ?? [];
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

      // if (!!consumer.enabled && !consumer.enabled) {
      //   this.logger.debug({
      //     type: "initialization",
      //     title: `[AMQP] [INIT] Consumer ${consumer.queue} is DISABLED`,
      //   })
      //   continue;
      // }


      const instance = this.moduleRef.get(consumer.handler.provider, { strict: false });
      const handler = instance[consumer.handler.methodName]

      if (typeof handler !== 'function') {
        throw new Error(`RabbitMQModule: Method ${consumer.handler.methodName} not found on ${instance.constructor.name}`);
      }

      await new RabbitMQConsumer(
        AMQPConnectionManager.consumerConn,
        this.rabbitModuleOptions,
        AMQPConnectionManager.publishChannelWrapper,
      ).createConsumer(consumer, handler.bind(instance))

      this.logger.debug({
        type: "initialization",
        title: `[AMQP] [INIT] Initializing consumer ${consumer.queue}`,
        binding: { exchange: consumer.exchangeName, routingKey: consumer.routingKey, group: consumer.group },
      })
    }
  }

  // private checkDuplicatedQueues(consumerList: RabbitMQConsumerChannel[]): void {
  //   const queueNameList = [];
  //   consumerList.map((curr) => queueNameList.push(curr.options.queue));
  //   const dedupList = new Set(queueNameList);
  //
  //   if (dedupList.size != queueNameList.length) {
  //     this.logger.error({
  //       error: "duplicated_queues",
  //       description: "Cannot have multiple queues on different binds",
  //       queues: Array.from(
  //         new Set(
  //           queueNameList.filter(
  //             (value, index) => queueNameList.indexOf(value) != index,
  //           ),
  //         ),
  //       ),
  //     });
  //
  //     process.exit(-1);
  //   }
  // }
}
