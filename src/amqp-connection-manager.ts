import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  OnModuleInit,
} from "@nestjs/common";
import { merge } from "./helper";
import { RabbitMQConsumer } from "./rabbitmq-consumer";
import {
  ConnectionConfig,
  LogType,
  ModuleOptions,
  RabbitMQConsumerResolved,
} from "./rabbitmq.types";
import { RABBIT_OPTIONS } from "./rabbitmq.constants";
import { ClassDiscovery } from "./class-discovery";
import { ConnectionFactory, ConnectionHolder } from "./connection-factory";

@Injectable()
export class AMQPConnectionManager
  implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger: Logger;
  private defaultOptions: Partial<ModuleOptions> = {
    extraOptions: {
      logType: "none",
      consumerManualLoad: false,
      heartbeatIntervalInSeconds: 0,
      reconnectTimeInSeconds: 5,
    },
  };
  private opts: ModuleOptions;
  private connections: Map<string, ConnectionHolder> = new Map();
  private connectionFactory: ConnectionFactory;
  public consumerInitialized: boolean = false;

  constructor(
    @Inject(RABBIT_OPTIONS) options: ModuleOptions,
    private readonly classDiscovery: ClassDiscovery,
  ) {
    this.opts = merge(
      this.defaultOptions,
      options
    );

    this.opts.extraOptions.logType = process.env?.RABBITMQ_LOG_TYPE as LogType ?? this.opts.extraOptions.logType;
    this.logger = new Logger(AMQPConnectionManager.name);
    this.connectionFactory = new ConnectionFactory(this.opts);
  }

  async onModuleInit() {
    return this.connect();
  }

  async onApplicationBootstrap() {
    if (this.opts.extraOptions.consumerManualLoad) return;
    await this.createConsumers();
    this.logger.debug("Initiating RabbitMQ consumers automatically");
  }

  getLogType(): LogType {
    return this.opts.extraOptions.logType;
  }

  public getConnectionHolder(name: string = "default"): ConnectionHolder {
    const holder = this.connections.get(name);
    if (!holder) {
      throw new Error(
        `RabbitMQModule: Connection "${name}" not found. Available: ${[...this.connections.keys()].join(", ")}`
      );
    }
    return holder;
  }

  public getAllConnections(): ConnectionHolder[] {
    return [...this.connections.values()];
  }

  async createConsumers(group?: string): Promise<void> {
    if (this.consumerInitialized)
      throw new Error("RabbitMQModule: Consumers are already initialized.")

    const consumerGroup = process.env?.RMQ_CONSUMER_GROUP?.toLocaleLowerCase()?.trim() ?? group ?? "rabbit-default"

    if (consumerGroup !== "rabbit-default") {
      this.logger.log(`Initializing consumers with group: ${consumerGroup}`)
    } else {
      this.logger.log(`No groups associated, initializing all consumers without groups`)
    }

    const allConsumers: Array<RabbitMQConsumerResolved> = [];

    for (const [connName, holder] of this.connections) {
      const configConsumers = this.classDiscovery
        .getConfigConsumers(holder.config.consumerChannels ?? [])
        .map(c => ({ ...c, connection: connName }));
      allConsumers.push(...configConsumers);
    }

    const decoratorConsumers = this.classDiscovery.discoverDecoratedConsumers();
    allConsumers.push(...decoratorConsumers);

    const dupQueues = new Set<string>();
    for (const c of allConsumers) {
      if (dupQueues.has(c.queue)) {
        throw new Error(`RabbitMQModule: Duplicate queue name "${c.queue}" found across config and decorator consumers.`);
      }
      dupQueues.add(c.queue);
    }

    for (const consumer of allConsumers) {
      consumer.group = consumer.group ?? consumerGroup;
      if (consumer.group !== consumerGroup) continue;

      if (consumer.enabled === false) {
        this.logger.debug({ type: "initialization", title: `[AMQP] [INIT] Consumer ${consumer.queue} is DISABLED` });
        continue;
      }

      const connName = consumer.connection ?? "default";
      await this.buildConsumer(connName).createConsumer(consumer, consumer.handler)

      this.logger.debug({
        type: "initialization",
        title: `[AMQP] [INIT] Initializing consumer ${consumer.queue}`,
        binding: { exchange: consumer.exchangeName, routingKey: consumer.routingKey, group: consumer.group },
      });
    }

    this.consumerInitialized = true;
  }

  async onApplicationShutdown() {
    this.logger.log("Closing RabbitMQ connections");
    for (const [, holder] of this.connections) {
      await holder.consumerConn?.close();
      await holder.publisherConn?.close();
    }
  }

  private resolveConnections(): Array<ConnectionConfig> {
    if (this.opts.connectionString && this.opts.connections) {
      throw new Error(
        'RabbitMQModule: Cannot set both "connectionString" and "connections". Use one or the other.'
      );
    }

    if (this.opts.connections) {
      const names = this.opts.connections.map(c => c.name);
      const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
      if (duplicates.length > 0) {
        throw new Error(`RabbitMQModule: Duplicate connection name "${duplicates[0]}".`);
      }
      return this.opts.connections;
    }

    return [{
      name: "default",
      connectionString: this.opts.connectionString,
      delayExchangeName: this.opts.delayExchangeName,
      assertExchanges: this.opts.assertExchanges,
      consumerChannels: this.opts.consumerChannels,
    }];
  }

  private async connect(): Promise<void> {
    const configs = this.resolveConnections();

    for (const config of configs) {
      const holder = await this.connectionFactory.create(config);
      this.connections.set(config.name, holder);
    }
  }

  private buildConsumer(connectionName: string = "default"): RabbitMQConsumer {
    const holder = this.getConnectionHolder(connectionName);
    return new RabbitMQConsumer(
      holder.consumerConn,
      holder.config.delayExchangeName,
      this.opts.extraOptions.logType,
      holder.publisherWrapper,
    );
  }
}
