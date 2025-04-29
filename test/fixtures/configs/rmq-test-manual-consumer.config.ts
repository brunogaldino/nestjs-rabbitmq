import { Injectable } from "@nestjs/common";
import { RabbitMQModuleOptions, RabbitOptionsFactory } from "../../../src";
import { RmqTestService } from "../rmq-test.service";
import { TestConsumers } from "./rmq-test.config";

export const delayExchangeName = "test_delay";

@Injectable()
export class RmqTestManualConsumerConfig implements RabbitOptionsFactory {
  constructor(private readonly rmqTest: RmqTestService) {}

  createRabbitOptions(): RabbitMQModuleOptions {
    return {
      connectionString: "amqp://guest:guest@localhost:5672",
      delayExchangeName: delayExchangeName,
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
