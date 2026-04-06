import { DynamicModule, Global, Module, Provider, Type } from "@nestjs/common";
import { AMQPConnectionManager } from "./amqp-connection-manager";
import { RabbitMQService } from "./rabbitmq-service";
import { ModuleOptions } from "./rabbitmq.types";
import { RabbitMQOptionsFactory, ModuleAsyncOptions } from "./rabbitmq.interfaces";
import { RABBIT_CONSUMER_HANDLERS, RABBIT_OPTIONS } from "./rabbitmq.constants";
import { DiscoveryModule } from "@nestjs/core";
import { ClassDiscovery } from "./class-discovery";
import { ConsumerActivator } from "./consumer-activator.service";

@Module({})
class RabbitMQConsumerModule { }

@Global()
@Module({})
export class RabbitMQModule {
  static forRoot(options: ModuleOptions): DynamicModule {
    return {
      module: RabbitMQModule,
      global: true,
      providers: [
        { provide: RABBIT_OPTIONS, useValue: options },
        AMQPConnectionManager,
        RabbitMQService,
      ],
      exports: [RabbitMQService, AMQPConnectionManager],
    };
  }

  static forRootAsync(options: ModuleAsyncOptions): DynamicModule {
    const injectProviders = (options.inject || []).filter(
      (item) => typeof item === 'function'
    ) as Provider[];

    return {
      module: RabbitMQModule,
      global: true,
      imports: [...options?.imports ?? []],
      providers: [
        ...injectProviders,
        ...this.createAsyncProviders(options),
        AMQPConnectionManager,
        RabbitMQService,
      ],
      exports: [RabbitMQService, AMQPConnectionManager],
    };
  }

  private static createAsyncOptionsProvider(options: ModuleAsyncOptions): Provider {
    if (options.useFactory) {
      return {
        provide: RABBIT_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject || [],
      };
    }

    return {
      provide: RABBIT_OPTIONS,
      useFactory: async (optionsFactory: RabbitMQOptionsFactory) =>
        optionsFactory.createRabbitOptions(),
      inject: [options.useClass || options.useExisting],
    };
  }

  private static createAsyncProviders(options: ModuleAsyncOptions): Provider[] {
    if (options.useFactory || options.useExisting) {
      return [this.createAsyncOptionsProvider(options)];
    }

    if (options.useClass) {
      return [
        this.createAsyncOptionsProvider(options),
        {
          provide: options.useClass,
          useClass: options.useClass,
        },
      ];
    }

    return [];
  }

  /** Enables specific consumer handlers. Every `@RabbitConsumer` declared inside the
   * handler, will be initialized.
   *
   * If no arguments are passed, every discoverable `@RabbitConsumer` will be initialized
   *
   * @example
   * ```
   * RabbitMQModule.forRootAsync({ useClass: RabbitConfig })
   * RabbitMQModule.withConsumers([PaymentConsumer, OrderConsumer])
   * ```
  */
  static withConsumers(handlers?: Type[]): DynamicModule {
    return {
      module: RabbitMQConsumerModule,
      imports: [DiscoveryModule],
      providers: [
        { provide: RABBIT_CONSUMER_HANDLERS, useValue: handlers ?? null },
        ClassDiscovery,
        ConsumerActivator,
      ],
    };
  }
}
