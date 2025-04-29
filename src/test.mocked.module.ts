import { DynamicModule, Module, Type } from "@nestjs/common";
import { mock } from "jest-mock-extended";
import { RabbitOptionsFactory } from "./rabbitmq.interfaces";
import { AMQPConnectionManager } from "./amqp-connection-manager";
import { RabbitMQService } from "./rabbitmq-service";

export type RabbitOptions = {
  useClass: Type<RabbitOptionsFactory>;
  injects?: any[];
};

const mockAmqpConnectionManager = mock(AMQPConnectionManager);
@Module({})
export class RabbitMQMockedTestModule {
  static register(options: RabbitOptions): DynamicModule {
    return {
      module: RabbitMQMockedTestModule,
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