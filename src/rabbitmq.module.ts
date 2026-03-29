import { DynamicModule, Global, Module, Provider } from "@nestjs/common";
import { AMQPConnectionManager } from "./amqp-connection-manager";
import { RabbitMQService } from "./rabbitmq-service";
import { RabbitMQModuleAsyncOptions, ModuleOptions } from "./rabbitmq.types";
import { RabbitMQOptionsFactory } from "./rabbitmq.interfaces";
import { RABBIT_OPTIONS } from "./rabbitmq.constants";
import { DiscoveryModule } from "@nestjs/core";
import { ClassDiscovery } from "./class-discovery";

@Global()
@Module({})
export class RabbitMQModule {
  static forRoot(options: ModuleOptions): DynamicModule {
    return {
      module: RabbitMQModule,
      global: true,
      imports: [DiscoveryModule],
      providers: [
        { provide: RABBIT_OPTIONS, useValue: options },
        AMQPConnectionManager,
        RabbitMQService,
        ClassDiscovery,
      ],
      exports: [RabbitMQService],
    };
  }

  static forRootAsync(options: RabbitMQModuleAsyncOptions): DynamicModule {
    const injectProviders = (options.inject || []).filter(
      (item) => typeof item === 'function'
    ) as Provider[];

    return {
      module: RabbitMQModule,
      imports: [DiscoveryModule, ...options?.imports ?? []],
      providers: [
        ...injectProviders,
        ...this.createAsyncProviders(options),
        AMQPConnectionManager,
        RabbitMQService,
        ClassDiscovery,
      ],
      exports: [RabbitMQService],
    };
  }

  private static createAsyncOptionsProvider(options: RabbitMQModuleAsyncOptions): Provider {
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

  private static createAsyncProviders(options: RabbitMQModuleAsyncOptions): Provider[] {
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
}
