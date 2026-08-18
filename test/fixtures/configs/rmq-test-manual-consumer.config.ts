import { Injectable } from "@nestjs/common";
import { RabbitMQModuleOptions, RabbitOptionsFactory } from "../../../src";
import { RmqTestService } from "../rmq-test.service";
import { TestConsumers } from "./rmq-test.config";

@Injectable()
export class RmqTestManualConsumerConfig implements RabbitOptionsFactory {
  constructor(private readonly rmqTest: RmqTestService) {}

  createRabbitOptions(): RabbitMQModuleOptions {
    return {
      connectionString: "amqp://localhost:5672",
      extraOptions: {
        consumerManualLoad: true,
        logType: "none",
      },
      assertExchanges: [{ name: "test_direct.exchange", type: "direct" }],
      consumerChannels: [
        {
          options: {
            ...TestConsumers[0],
          },
          messageHandler: this.rmqTest.messageHandler.bind(this.rmqTest),
        },
      ],
    };
  }
}
