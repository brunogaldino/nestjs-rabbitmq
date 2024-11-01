import { DynamicModule, Module, Type } from "@nestjs/common";
import { AMQPConnectionManager } from "../amqp-connection-manager";
import { RabbitMQService } from "../rabbitmq-service";
import { RabbitOptionsFactory } from "../rabbitmq.interfaces";
import { mock } from "jest-mock-extended";

export type RabbitOptions = {
  useClass: Type<RabbitOptionsFactory>;
  injects?: any[];
};

const mockAmqpConnectionManager = mock(AMQPConnectionManager);
@Module({})
export class RabbitMQTestModule {
  static register(options: RabbitOptions): DynamicModule {
    return {
      module: RabbitMQTestModule,
      imports: options?.injects ?? [],
      global: true,
      providers: [
        mockAmqpConnectionManager,
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
