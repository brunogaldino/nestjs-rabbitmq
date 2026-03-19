import { DynamicModule, Module, Type } from "@nestjs/common";
import { DiscoveryModule } from '@nestjs/core';
import { AMQPConnectionManager } from "./amqp-connection-manager";
import { RabbitMQService } from "./rabbitmq-service";
import { RabbitOptionsFactory } from "./rabbitmq.interfaces";

export type RabbitOptions = {
  useClass: Type<RabbitOptionsFactory>;
};

@Module({})
export class RabbitMQModule {
  static register(options: RabbitOptions): DynamicModule {
    return {
      module: RabbitMQModule,
      global: true,
      imports: [DiscoveryModule],
      providers: [
        AMQPConnectionManager,
        {
          provide: "RABBIT_OPTIONS",
          useClass: options.useClass,
        },
        RabbitMQService,
      ],
      exports: [RabbitMQService],
    };
  }
}
