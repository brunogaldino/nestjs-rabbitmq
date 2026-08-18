import { Inject, Injectable, Logger, OnApplicationBootstrap, Type } from "@nestjs/common";
import { AMQPConnectionManager } from "./amqp-connection-manager";
import { ClassDiscovery } from "./class-discovery";
import { RABBIT_CONSUMER_HANDLERS } from "./rabbitmq.constants";
import { RabbitMQConsumerResolved } from "./rabbitmq.types";

@Injectable()
export class ConsumerActivator implements OnApplicationBootstrap {
  private readonly logger = new Logger(ConsumerActivator.name);

  constructor(
    private readonly connManager: AMQPConnectionManager,
    private readonly classDiscovery: ClassDiscovery,
    @Inject(RABBIT_CONSUMER_HANDLERS)
    private readonly handlers: Type[] | null,
  ) { }

  async onApplicationBootstrap() {
    const consumers = this.discoverConsumers();

    if (consumers.length === 0) {
      this.logger.log('No consumers discovered');
      return;
    }

    this.logger.log(`Activating ${consumers.length} consumer(s)`);
    await this.connManager.activateConsumers(consumers);
  }

  private discoverConsumers(): RabbitMQConsumerResolved[] {
    const all: RabbitMQConsumerResolved[] = [];

    if (this.handlers) {
      all.push(...this.classDiscovery.discoverFromClasses(this.handlers));
    } else {
      all.push(...this.classDiscovery.discoverDecoratedConsumers());
    }

    // Config consumers from each connection
    for (const holder of this.connManager.getAllConnections()) {
      const configConsumers = this.classDiscovery
        .getConfigConsumers(holder.config.consumerChannels ?? [])
        .map(c => ({ ...c, connection: holder.config.name }));
      all.push(...configConsumers);
    }

    return all;
  }
}
