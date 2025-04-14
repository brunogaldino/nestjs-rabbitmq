import { Test, TestingModule } from "@nestjs/testing";
import { RabbitMQModule, RabbitMQService } from "../src";
import { AMQPConnectionManager } from "../src/amqp-connection-manager";
import { RmqTestConfig } from "./fixtures/configs/rmq-test.config";
import { RmqTestModule } from "./fixtures/rmq-test.module";
import { RmqTestService } from "./fixtures/rmq-test.service";
import { Logger } from "@nestjs/common";

describe("CrashedConnection", () => {
  let rabbitMqService: RabbitMQService;
  let amqpManager: AMQPConnectionManager;
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        RmqTestModule,
        RabbitMQModule.register({
          useClass: RmqTestConfig,
          injects: [RmqTestModule],
        }),
      ],
    }).compile();

    moduleRef.useLogger(false);
    moduleRef = await moduleRef.init();

    amqpManager = moduleRef.get(AMQPConnectionManager);
    rabbitMqService = moduleRef.get(RabbitMQService);

    await AMQPConnectionManager.publishChannelWrapper.waitForConnect();

    for (const consumer of amqpManager.getConsumers()) {
      await consumer.waitForConnect();
    }
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it("should throw a message if exchange does not exists and log it", async () => {
    jest.clearAllMocks();

    const spy = jest.spyOn(RabbitMQService.prototype, "publish");
    const logSpy = jest.spyOn(Logger.prototype, "error");
    jest.spyOn(RmqTestService.prototype, "messageHandler").mockImplementation();

    await rabbitMqService.publish("not_exists.exchange", "not_exists.key", {
      test: "error",
    });

    expect(spy).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalled();

    expect(logSpy.mock.lastCall?.[0]).toMatchObject(
      {
        logLevel: "error",
        title: `[AMQP] [PUBLISH] [not_exists.exchange] [not_exists.key]`,
        binding: {
          routingKey: "not_exists.key",
          exchange: "not_exists.exchange",
        },
        publishedMessage: {
          content: { test: "error" },
        },
        error: expect.objectContaining({ message: "channel closed" }),
      },
    );
  });
});
