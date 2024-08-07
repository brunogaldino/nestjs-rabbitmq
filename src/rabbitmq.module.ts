import { DynamicModule, Module, Type } from "@nestjs/common";
import { AMQPConnectionManager } from "./amqp-connection-manager";
import { RabbitMQService } from "./rabbitmq-service";
import { RabbitOptionsFactory } from "./rabbitmq.interfaces";

export type RabbitOptions = {
  useClass: Type<RabbitOptionsFactory>;
  injects?: any[];
};

@Module({})
export class RabbitMQModule {
  static register(options: RabbitOptions): DynamicModule {
    return {
      module: RabbitMQModule,
      imports: [...(options?.injects ?? [])],
      global: true,
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
