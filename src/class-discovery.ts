import { Injectable, Type } from "@nestjs/common";
import { DiscoveryService, MetadataScanner, Reflector } from "@nestjs/core";
import { ConsumerChannel, ConsumerOptions, RabbitMQConsumerResolved } from "./rabbitmq.types";
import { RABBIT_HANDLER_METADATA } from "./rabbit-consumer.decorator";
import { InstanceWrapper } from "@nestjs/core/injector/instance-wrapper";

@Injectable()
export class ClassDiscovery {
  private readonly wrappers: InstanceWrapper[];

  constructor(
    private readonly discoveryService: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
    private readonly reflector: Reflector
  ) {
    this.wrappers = [...this.discoveryService.getProviders(), ...this.discoveryService.getControllers()]
  }

  public getProviderInstance<T>(provider: Type<T>): T {
    const wrapper = this.wrappers.find(w => w.metatype === provider)
    if (!wrapper?.instance) {
      throw new Error(`RabbitMQModule: Provider ${provider.name} not found. Is it registered in a module?`);
    }

    return wrapper.instance as T;
  }

  public discoverDecoratedConsumers(): Array<RabbitMQConsumerResolved> {
    const discovered: Array<RabbitMQConsumerResolved> = [];

    for (const wrapper of this.wrappers) {
      const { instance } = wrapper;
      if (!instance || !Object.getPrototypeOf(instance)) continue;

      const methods = this.metadataScanner.getAllMethodNames(instance);

      for (const method of methods) {
        const meta = this.reflector.get<ConsumerOptions>(RABBIT_HANDLER_METADATA, instance[method]);
        if (!meta) continue;

        this.resolveStrategyMethods(meta, instance);

        discovered.push({
          ...meta,
          handler: instance[method].bind(instance),
        })
      }
    }

    return discovered;
  }

  public discoverFromClasses(classes: Type[]): Array<RabbitMQConsumerResolved> {
    const discovered: Array<RabbitMQConsumerResolved> = [];

    for (const cls of classes) {
      const wrapper = this.wrappers.find(w => w.metatype === cls);
      if (!wrapper?.instance) {
        throw new Error(
          `RabbitMQModule: Provider ${cls.name} not found. Is it registered in a module?`
        );
      }

      const { instance } = wrapper;
      const methods = this.metadataScanner.getAllMethodNames(instance);

      for (const method of methods) {
        const meta = this.reflector.get<ConsumerOptions>(
          RABBIT_HANDLER_METADATA,
          instance[method],
        );
        if (!meta) continue;

        this.resolveStrategyMethods(meta, instance);
        discovered.push({
          ...meta,
          handler: instance[method].bind(instance),
        });
      }
    }

    return discovered;
  }

  public getConfigConsumers(consumerList: Array<ConsumerChannel>): Array<RabbitMQConsumerResolved> {
    const consumers: Array<RabbitMQConsumerResolved> = []

    for (const consumer of consumerList ?? []) {
      const instance = this.getProviderInstance(consumer.handler.provider);
      const handler = instance[consumer.handler.methodName]

      if (typeof handler !== 'function') {
        throw new Error(`RabbitMQModule: Method ${consumer.handler.methodName} not found on ${instance.constructor.name}`);
      }

      const { handler: _, ...options } = consumer;
      consumers.push({
        ...options,
        handler: handler.bind(instance)
      });
    }

    return consumers;
  }

  private resolveStrategyMethods(meta: ConsumerOptions, instance: any): void {
    const className = instance.constructor.name;

    if (typeof meta.retryStrategy?.delay === "string") {
      const fn = instance[meta.retryStrategy.delay];
      if (typeof fn !== "function") {
        throw new Error(`RabbitMQModule: Method "${meta.retryStrategy.delay}" not found on ${className}`);
      }
      meta.retryStrategy.delay = fn.bind(instance);
    }

    if (typeof meta.deadLetterStrategy?.callback === "string") {
      const fn = instance[meta.deadLetterStrategy.callback];
      if (typeof fn !== "function") {
        throw new Error(`RabbitMQModule: Method "${meta.deadLetterStrategy.callback}" not found on ${className}`);
      }
      meta.deadLetterStrategy.callback = fn.bind(instance);
    }
  }
}
