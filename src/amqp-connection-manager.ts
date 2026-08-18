import {
  Inject,
  Injectable,
  Logger,
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
import { ConnectionFactory, ConnectionHolder } from "./connection-factory";

@Injectable()
export class AMQPConnectionManager
  implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(AMQPConnectionManager.name);
  private defaultOptions: Partial<ModuleOptions> = {
    extraOptions: {
      logType: "none",
      heartbeatIntervalInSeconds: 0,
      reconnectTimeInSeconds: 5,
      defaultMaxRetry: 5,
      defaultRetryFn: () => 5000
    },
  };
  private opts: ModuleOptions;
  private connections: Map<string, ConnectionHolder> = new Map();
  private connectionFactory: ConnectionFactory;
  private resolveConnection: () => void;
  private readonly connectionReady: Promise<void>;

  constructor(
    @Inject(RABBIT_OPTIONS) options: ModuleOptions,
  ) {
    this.opts = merge(
      this.defaultOptions,
      options
    );

    this.opts.extraOptions.logType = process.env?.RABBITMQ_LOG_TYPE as LogType ?? this.opts.extraOptions.logType;
    this.connectionFactory = new ConnectionFactory(this.opts);
    this.connectionReady = new Promise(resolve => {
      this.resolveConnection = resolve;
    });
  }

  async onModuleInit() {
    await this.connectPublishers();
    this.resolveConnection();
  }


  private async connectPublishers(): Promise<void> {
    const configs = this.resolveConnections();
    for (const config of configs) {
      const holder = await this.connectionFactory.createPublisher(config);
      this.connections.set(config.name, holder);
    }
  }

  getLogType(): LogType {
    return this.opts.extraOptions.logType;
  }

  public async ensureConnected(): Promise<void> {
    await this.connectionReady;
  }

  public getConnectionHolder(name: string = "default"): ConnectionHolder {
    const holder = this.connections.get(name);
    if (!holder) {
      const available = [...this.connections.keys()];
      const hint = available.length === 0
        ? " Connections may not have been established yet. Ensure RabbitMQModule is imported before modules that depend on it."
        : "";
      throw new Error(
        `RabbitMQModule: Connection "${name}" not found. Available: ${available.join(", ")}.${hint}`
      );
    }
    return holder;
  }

  public getAllConnections(): ConnectionHolder[] {
    return [...this.connections.values()];
  }

  async activateConsumers(consumers: RabbitMQConsumerResolved[]): Promise<void> {
    for (const [, holder] of this.connections) {
      if (!holder.consumerConn) {
        await this.connectionFactory.attachConsumer(holder)
      }
    }

    const dupQueues = new Set<string>();
    for (const c of consumers) {
      if (dupQueues.has(c.queue))
        throw new Error(`Duplicate queue "${c.queue}"`);
      dupQueues.add(c.queue);
    }

    for (const consumer of consumers) {
      if (consumer.enabled === false) continue;
      const connName = consumer.connection ?? "default";
      await this.buildConsumer(connName).createConsumer(consumer, consumer.handler);
    }
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
      assertExchanges: this.opts.assertExchanges,
      consumerChannels: this.opts.consumerChannels,
    }];
  }

  private buildConsumer(connectionName: string = "default"): RabbitMQConsumer {
    const holder = this.getConnectionHolder(connectionName);
    return new RabbitMQConsumer(
      holder.consumerConn,
      this.opts.extraOptions.logType,
      holder.publisherWrapper,
      this.opts.extraOptions.defaultMaxRetry,
      this.opts.extraOptions.defaultRetryFn,
    );
  }
}
