import { connect } from "amqp-connection-manager";
import {
  TestConsumers,
  TestExchanges,
} from "./fixtures/configs/rmq-test.config";

export default async function (globalConfig, projectConfig) {
  const connection = connect("amqp://localhost:5672", {
    heartbeatIntervalInSeconds: 5,
    reconnectTimeInSeconds: 5,
  });

  const channel = connection.createChannel();
  await channel.waitForConnect();

  for (const consumer of TestConsumers) {
    await channel.deleteQueue(consumer.queue);
    await channel.deleteQueue(consumer.queue + ".dlq");
  }

  for (const exchange of TestExchanges) {
    await channel.deleteExchange(exchange.name);
  }

  await channel.close();
  await connection.close();
}
