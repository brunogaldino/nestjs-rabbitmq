import { Test, TestingModule } from "@nestjs/testing";
import {
  delayExchangeName,
  RmqTestConfig,
  TestConsumers,
  TestExchanges,
} from "./fixtures/configs/rmq-test.config";
import { RmqTestModule } from "./fixtures/rmq-test.module";
import { RabbitMQModule } from "../src/rabbitmq.module";
import { RmqTestService } from "./fixtures/rmq-test.service";
import { RabbitMQService } from "../src/rabbitmq-service";
import { AMQPConnectionManager } from "../src/amqp-connection-manager";
import { once } from "events";
import { RabbitMQConsumer } from "../src/rabbitmq-consumers";
import { Logger } from "@nestjs/common";

export const sleep = (ms: number = 200) => {
  return new Promise<void>((resolve) =>
    setTimeout(() => {
      resolve();
    }, ms),
  );
};

describe("AMQPConnectionManager", () => {
  let rabbitMqService: RabbitMQService;
  let amqpManager: AMQPConnectionManager;
  let testService: RmqTestService;
  let moduleRef: TestingModule;
  let globalConsumerThrowSpy: any;

  beforeAll(async () => {
    globalConsumerThrowSpy = jest.spyOn(
      RmqTestService.prototype,
      "throwHandler",
    );

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
    testService = moduleRef.get(RmqTestService);

    await AMQPConnectionManager.publishChannelWrapper.waitForConnect();

    for (const consumer of amqpManager.getConsumers()) {
      await consumer.waitForConnect();
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  it("should return a truthy connection health", async () => {
    expect(testService.rabbitService.checkHealth()).toBeTruthy();
  });

  it("should assert the retry delay exchange", async () => {
    expect(
      await AMQPConnectionManager.publishChannelWrapper.checkExchange(
        delayExchangeName + ".delay",
      ),
    ).toBeDefined();
  });

  describe("Publisher", () => {
    it("should have a publisher channel connected", async () => {
      expect(AMQPConnectionManager.publishChannelWrapper).toBeDefined();
      expect(
        once(AMQPConnectionManager.publishChannelWrapper, "connect"),
      ).resolves.toBeDefined();
    });

    it("should have all declared exchanges created", async () => {
      for (const exchange of TestExchanges) {
        expect(
          await AMQPConnectionManager.publishChannelWrapper.checkExchange(
            exchange.name,
          ),
        ).toBeDefined();
      }
    });

    it("should publish a message to a declared exchange and log it with custom headers", async () => {
      jest.clearAllMocks();

      const spy = jest.spyOn(RabbitMQService.prototype, "publish");
      const rabbitPublish = jest.spyOn(
        AMQPConnectionManager.publishChannelWrapper,
        "publish",
      );

      const loggerSpy = jest.spyOn(Logger.prototype, "log");

      jest
        .spyOn(RmqTestService.prototype, "messageHandler")
        .mockImplementation(async () => { });

      const isPublished = await rabbitMqService.publish(
        TestConsumers[0].exchangeName,
        TestConsumers[0].routingKey as string,
        { test: "published" },
        { correlationId: "123" },
      );

      expect(spy).toHaveBeenCalled();

      expect(rabbitPublish).toHaveBeenCalledWith(
        TestConsumers[0].exchangeName,
        TestConsumers[0].queue,
        JSON.stringify({ test: "published" }),
        {
          correlationId: "123",
          deliveryMode: 2,
          persistent: true,
          headers: {
            "x-application-headers": {
              "original-exchange": TestConsumers[0].exchangeName,
              "original-routing-key": TestConsumers[0].routingKey,
              "published-at": expect.any(String),
            },
          },
        },
      );

      expect(isPublished).toBeTruthy();

      expect(loggerSpy.mock.lastCall?.[0]).toMatchObject(
        {
          logLevel: "log",
          title: `[AMQP] [PUBLISH] [${TestConsumers[0].exchangeName}] [${TestConsumers[0].routingKey}]`,
          binding: {
            routingKey: TestConsumers[0].routingKey,
            exchange: TestConsumers[0].exchangeName,
          },
          correlationId: "123",
          publishedMessage: {
            content: { test: "published" },
            properties: { correlationId: "123" },
          },
        },
      );
    });

    it("should publish a message with custom headers, and keep the application's default headers, in addition to keeping the correct values ​​in the header", async () => {
      jest.clearAllMocks();

      const spy = jest.spyOn(RabbitMQService.prototype, "publish");
      const rabbitPublish = jest.spyOn(
        AMQPConnectionManager.publishChannelWrapper,
        "publish",
      );

      const loggerSpy = jest.spyOn(Logger.prototype, "log");

      jest
        .spyOn(RmqTestService.prototype, "messageHandler")
        .mockImplementation(async () => { });

      const isPublished = await rabbitMqService.publish(
        TestConsumers[0].exchangeName,
        TestConsumers[0].routingKey as string,
        { test: "published" },
        {
          correlationId: "123", headers: {
            custom: "custom"
          }
        },
      );

      expect(spy).toHaveBeenCalled();

      expect(rabbitPublish).toHaveBeenCalledWith(
        TestConsumers[0].exchangeName,
        TestConsumers[0].queue,
        JSON.stringify({ test: "published" }),
        {
          correlationId: "123",
          deliveryMode: 2,
          persistent: true,
          headers: {
            "custom": "custom",
            "x-application-headers": {
              "original-exchange": TestConsumers[0].exchangeName,
              "original-routing-key": TestConsumers[0].routingKey,
              "published-at": expect.any(String),
            },
          },
        },
      );

      const publishedAt = loggerSpy.mock.lastCall?.[0].publishedMessage.properties.headers["x-application-headers"]["published-at"]
      expect(isPublished).toBeTruthy();
      expect(publishedAt).toBeDefined()
      expect(() => new Date(publishedAt).toISOString()).not.toThrow();
      expect(loggerSpy.mock.lastCall?.[0]).toMatchObject(
        {
          logLevel: "log",
          title: `[AMQP] [PUBLISH] [${TestConsumers[0].exchangeName}] [${TestConsumers[0].routingKey}]`,
          binding: {
            routingKey: TestConsumers[0].routingKey,
            exchange: TestConsumers[0].exchangeName,
          },
          correlationId: "123",
          publishedMessage: {
            content: { test: "published" },
            properties: {
              persistent: true,
              deliveryMode: 2,
              correlationId: "123", headers: {
                custom: "custom",
                "x-application-headers": {
                  "original-exchange": TestConsumers[0].exchangeName,
                  "original-routing-key": TestConsumers[0].routingKey,
                },
              }
            },
          },
        },
      );
    });

    it("should publish a array of messages to a declared exchange and log it with custom headers", async () => {
      jest.clearAllMocks();

      const spy = jest.spyOn(RabbitMQService.prototype, "publish");
      const rabbitPublish = jest.spyOn(
        AMQPConnectionManager.publishChannelWrapper,
        "publish",
      );

      const loggerSpy = jest.spyOn(Logger.prototype, "log");

      jest
        .spyOn(RmqTestService.prototype, "messageHandler")
        .mockImplementation(async () => { });

      const isPublished = await rabbitMqService.publishBulk(
        TestConsumers[0].exchangeName,
        TestConsumers[0].routingKey as string,
        [
          { test: "published" },
          { test: "published" },
          { test: "published" },
          { test: "published" },
        ],
        { correlationId: "123" },
      );

      expect(spy).toHaveBeenCalled();

      expect(rabbitPublish).toHaveBeenCalledWith(
        TestConsumers[0].exchangeName,
        TestConsumers[0].queue,
        JSON.stringify({ test: "published" }),
        {
          correlationId: "123",
          deliveryMode: 2,
          persistent: true,
          headers: {
            "x-application-headers": {
              "original-exchange": TestConsumers[0].exchangeName,
              "original-routing-key": TestConsumers[0].routingKey,
              "published-at": expect.any(String),
            },
          },
        },
      );

      expect(isPublished).toBeTruthy();

      expect(loggerSpy.mock.lastCall?.[0]).toMatchObject(
       {
          logLevel: "log",
          title: `[AMQP] [PUBLISH] [${TestConsumers[0].exchangeName}] [${TestConsumers[0].routingKey}]`,
          binding: {
            routingKey: TestConsumers[0].routingKey,
            exchange: TestConsumers[0].exchangeName,
          },
          correlationId: "123",
          publishedMessage: {
            content: { test: "published" },
            properties: { correlationId: "123" },
          },
        },
      );
    });

    it("should publish an array of messages and return 1 failed message", async () => {
      jest.spyOn(AMQPConnectionManager.publishChannelWrapper, "publish");
      jest
        .spyOn(rabbitMqService, "publish")
        .mockResolvedValueOnce(false)
        .mockResolvedValue(true);
      jest
        .spyOn(RmqTestService.prototype, "messageHandler")
        .mockImplementation(async () => { });

      const publisheds = await rabbitMqService.publishBulk<any>(
        TestConsumers[0].exchangeName,
        TestConsumers[0].routingKey as string,
        [
          { test: "failed" },
          { test: "published" },
          { test: "published" },
          { test: "published" },
        ],
        { correlationId: "123" },
      );

      expect(publisheds.length).toBe(1);
      expect(publisheds[0].test).toBe("failed");
    });

    it("should return messages that failed to publish if the connection to rabbitmq is lost", async () => {
      jest.spyOn(AMQPConnectionManager.publishChannelWrapper, "publish");
      jest.spyOn(rabbitMqService, "publish").mockResolvedValue(true);
      jest
        .spyOn(rabbitMqService, "checkHealth")
        .mockReturnValueOnce(1)
        .mockReturnValue(0);
      jest
        .spyOn(RmqTestService.prototype, "messageHandler")
        .mockImplementation(async () => { });

      const publisheds = await rabbitMqService.publishBulk<any>(
        TestConsumers[0].exchangeName,
        TestConsumers[0].routingKey as string,
        [
          { test: "failed" },
          { test: "published" },
          { test: "published" },
          { test: "published" },
        ],
        { correlationId: "123", batchSize: 1 },
      );

      expect(publisheds.length).toBe(2);
    });
  });

  describe("Consumer", () => {
    it("should have one channel for each consumer", async () => {
      expect(amqpManager.getConsumers().length).toEqual(TestConsumers.length);
      expect(amqpManager.getConnection("consumer").channelCount).toEqual(
        TestConsumers.length,
      );
    });

    it("should have all declared consumer queues created", async () => {
      for (const queue of TestConsumers) {
        expect(
          await AMQPConnectionManager.publishChannelWrapper.checkQueue(
            queue.queue,
          ),
        ).toBeDefined();
      }
    });

    it("should throw an error if consumers are already loaded", async () => {
      await expect(rabbitMqService.createConsumers()).rejects.toThrow(
        "Consumers already initialized. If you wish to start it manually, see consumeManualLoad",
      );
    });

    it("should have one .dlq for each queue", async () => {
      for (const queue of TestConsumers) {
        expect(
          await AMQPConnectionManager.publishChannelWrapper.checkQueue(
            queue.queue + ".dlq",
          ),
        ).toBeDefined();
      }
    });

    // it("should invoke callback when publishing message", async () => {
    //   const publishedMessage = { test: "test" };
    //   const loggerSpy = jest.spyOn(Logger.prototype, "log");
    //
    //   await rabbitMqService.publish(
    //     TestConsumers[0].exchangeName,
    //     TestConsumers[0].routingKey as string,
    //     publishedMessage,
    //   );
    //
    //   await sleep(1000);
    //
    //   expect(globalConsumerCallbackSpy).toHaveBeenCalledWith(
    //     publishedMessage,
    //     expect.objectContaining({
    //       queue: TestConsumers[0].queue,
    //     }),
    //   );
    //
    //   expect(globalConsumerCallbackSpy.mock.calls[0][1].queue).toBeDefined();
    //   expect(globalConsumerCallbackSpy.mock.calls[0][1].message).toBeDefined();
    //   expect(globalConsumerCallbackSpy.mock.calls[0][1].channel).toBeDefined();
    //
    //   expect(loggerSpy).toHaveBeenCalled();
    //   expect(JSON.parse(loggerSpy.mock.lastCall?.[0])).toMatchObject(
    //     expect.objectContaining({
    //       logLevel: "log",
    //       title: `[AMQP] [CONSUMER] [${TestConsumers[0].exchangeName}] [${TestConsumers[0].routingKey}] [${TestConsumers[0].queue}]`,
    //       binding: {
    //         queue: TestConsumers[0].queue,
    //         routingKey: TestConsumers[0].routingKey,
    //         exchange: TestConsumers[0].exchangeName,
    //       },
    //     }),
    //   );
    // });

    it("should attempt retry if callback throws, log it", async () => {
      const publishedMessage = { test: "test" };
      const loggerSpy = jest.spyOn(Logger.prototype, "error");

      const retrySpy = jest.spyOn(
        RabbitMQConsumer.prototype as any,
        "processRetry",
      );

      await rabbitMqService.publish(
        TestConsumers[1].exchangeName,
        TestConsumers[1].routingKey as string,
        publishedMessage,
      );

      await sleep();

      expect(globalConsumerThrowSpy).toHaveBeenCalledWith(
        publishedMessage,
        expect.objectContaining({
          queue: TestConsumers[1].queue,
        }),
      );

      expect(retrySpy).toHaveBeenCalled();
      expect(loggerSpy).toHaveBeenCalled();

      expect(loggerSpy.mock.lastCall?.[0]).toMatchObject(
        expect.objectContaining({
          logLevel: "error",
          title: `[AMQP] [CONSUMER] [${TestConsumers[1].exchangeName}] [${TestConsumers[1].routingKey}] [${TestConsumers[1].queue}]`,
          binding: {
            queue: TestConsumers[1].queue,
            routingKey: TestConsumers[1].routingKey,
            exchange: TestConsumers[1].exchangeName,
          },
          error: expect.objectContaining({ message: "throw_test" }),
        }),
      );
    });
  });
});
