import { Logger } from "@nestjs/common";
import {
  AmqpConnectionManager,
  ChannelWrapper,
  connect,
} from "amqp-connection-manager";
import { ConfirmChannel } from "amqplib";
import { hostname } from "node:os";
import { ConnectionConfig, ConnectionType, ModuleOptions } from "./rabbitmq.types";

export type ConnectionHolder = {
  config: ConnectionConfig;
  consumerConn: AmqpConnectionManager;
  publisherConn: AmqpConnectionManager;
  publisherWrapper: ChannelWrapper;
};

export class ConnectionFactory {
  private readonly logger = new Logger(ConnectionFactory.name);
  private readonly terminalErrors: string[] = [
    "channel-error",
    "precondition-failed",
    "not-allowed",
    "access-refused",
    "closed via management plugin",
  ];

  constructor(private readonly opts: ModuleOptions) { }

  async create(config: ConnectionConfig): Promise<ConnectionHolder> {
    const consumerConn = await this.connectBroker(config, "consumer");
    const publisherConn = await this.connectBroker(config, "publisher");
    const publisherWrapper = await this.assertExchanges(publisherConn, config);

    return { config, consumerConn, publisherConn, publisherWrapper };
  }

  private async connectBroker(config: ConnectionConfig, type: ConnectionType): Promise<AmqpConnectionManager> {
    const conn = connect(config.connectionString, this.buildConnectionOptions(`${config.name}-${type}`));

    await this.awaitConnection(conn, config.name, type);
    this.registerConnectionEvents(conn, config.name, type);

    return conn;
  }

  private awaitConnection(conn: AmqpConnectionManager, name: string, type: ConnectionType): Promise<void> {
    return new Promise<void>((resolve) => {
      conn.once("connect", ({ url }: { url: string }) => {
        this.logger.log(
          `[${name}] [${type}] Connected to ${url.replace(
            new RegExp(url.replace(/amqp:\/\/[^:]*:([^@]*)@.*?$/i, "$1"), "g"),
            "***",
          )}`,
        );
        resolve();
      });
    });
  }

  private registerConnectionEvents(conn: AmqpConnectionManager, name: string, type: ConnectionType): void {
    const prefix = `[${name}] [${type}]`;

    conn.on("disconnect", ({ err }) => {
      this.logger.warn(`${prefix} Disconnected: ${err.message}`);

      if (this.terminalErrors.some((msg) => err.message.toLowerCase().includes(msg))) {
        conn.close();
        this.logger.error(`${prefix} Terminal error, cannot reconnect: ${err.message}`);
      }
    });

    conn.on("connectFailed", ({ err }) => {
      this.logger.error(`${prefix} Connection failed: ${err.message}`);
    });

    if (type === "publisher") {
      conn.on("blocked", ({ reason }) => {
        this.logger.error(`${prefix} Blocked: ${reason}`);
      });

      conn.on("unblocked", () => {
        this.logger.log(`${prefix} Unblocked`);
      });
    }
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

  private async assertExchanges(publisherConn: AmqpConnectionManager, config: ConnectionConfig): Promise<ChannelWrapper> {
    const wrapper = publisherConn.createChannel({
      name: `${process.env.PROJECT_NAME}_publish_${config.name}`,
      confirm: true,
      publishTimeout: 60000,
    });

    await new Promise((resolve) => {
      wrapper.on("connect", () => {
        this.logger.debug(`[${config.name}] Publisher channel ready`);
        resolve(true);
      });

      wrapper.on("close", () => {
        this.logger.debug(`[${config.name}] Publisher channel closed`);
      });

      wrapper.on("error", (err, info) => {
        this.logger.error(`[${config.name}] Publisher channel error`, err, info);
      });
    });

    for (const exchange of config.assertExchanges ?? []) {
      await wrapper.addSetup(
        async (channel: ConfirmChannel) => {
          await channel.assertExchange(exchange.name, exchange.type, {
            durable: exchange?.options?.durable ?? true,
            autoDelete: exchange?.options?.autoDelete ?? false,
          });
        },
      );
    }

    return wrapper;
  }
}
