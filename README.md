# @bgaldino/nestjs-rabbitmq

An opinionated NestJS module for RabbitMQ with built-in retry strategies, dead letter queues, and quorum queue support.

## Table of Contents

- [Installation](#installation)
- [Requirements](#requirements)
- [Getting Started](#getting-started)
  - [forRoot](#forroot)
  - [forRootAsync](#forrootasync)
- [Consumers](#consumers)
  - [Decorator-based consumers](#decorator-based-consumers)
  - [Config-based consumers](#config-based-consumers)
  - [Mixed usage](#mixed-usage)
  - [Handler signature](#handler-signature)
  - [Consumer groups](#consumer-groups)
- [Publishers](#publishers)
  - [Publishing messages](#publishing-messages)
  - [Typed publishing](#typed-publishing)
- [Multi-vhost Connections](#multi-vhost-connections)
  - [Named connections](#named-connections)
  - [Targeting a connection from consumers](#targeting-a-connection-from-consumers)
  - [Publishing to a specific connection](#publishing-to-a-specific-connection)
- [Retry Strategy](#retry-strategy)
- [Dead Letter Strategy](#dead-letter-strategy)
- [Disabling the automatic ack](#disabling-the-automatic-ack)
- [Custom Header Metadata](#custom-header-metadata)
- [Extra Options](#extra-options)
  - [Consumer manual loading](#consumer-manual-loading)
  - [Message inspection and logging](#message-inspection-and-logging)
  - [Health check](#health-check)
- [Building locally](#building-locally)
- [License](#license)

## Installation

```shell
pnpm add @bgaldino/nestjs-rabbitmq
```

```shell
yarn add @bgaldino/nestjs-rabbitmq
```

```shell
npm add @bgaldino/nestjs-rabbitmq
```

## Requirements

- `@nestjs/common` and `@nestjs/core` version 9 or above
- RabbitMQ 3.10+ (quorum queue per-message TTL support)

No additional plugins are required. The retry mechanism uses native message TTL
and dead letter exchanges instead of the delayed message plugin.

## Getting Started

The `RabbitMQModule` is marked as `@Global`, so importing it once is enough
to inject `RabbitMQService` anywhere in your application.

### forRoot

For simple setups where the configuration is static:

```typescript
import { RabbitMQModule } from '@bgaldino/nestjs-rabbitmq';

@Module({
  imports: [
    RabbitMQModule.forRoot({
      connectionString: 'amqp://user:password@localhost:5672/vhost',
      delayExchangeName: 'my_app',
      assertExchanges: [
        { name: 'orders', type: 'topic' },
        { name: 'notifications', type: 'fanout' },
      ],
    }),
  ],
})
export class AppModule {}
```

### forRootAsync

When you need to inject dependencies or resolve configuration asynchronously:

```typescript
import { RabbitMQModule, RabbitMQOptionsFactory, ModuleOptions } from '@bgaldino/nestjs-rabbitmq';

@Injectable()
class RabbitConfig implements RabbitMQOptionsFactory {
  constructor(private readonly configService: ConfigService) {}

  createRabbitOptions(): ModuleOptions {
    return {
      connectionString: this.configService.get('RABBIT_URL'),
      delayExchangeName: 'my_app',
      assertExchanges: [
        { name: 'orders', type: 'topic' },
      ],
    };
  }
}

@Module({
  imports: [
    RabbitMQModule.forRootAsync({
      useClass: RabbitConfig,
      imports: [ConfigModule],
    }),
  ],
})
export class AppModule {}
```

You can also use `useFactory` directly:

```typescript
RabbitMQModule.forRootAsync({
  useFactory: (configService: ConfigService) => ({
    connectionString: configService.get('RABBIT_URL'),
    delayExchangeName: 'my_app',
    assertExchanges: [],
  }),
  inject: [ConfigService],
  imports: [ConfigModule],
})
```

## Consumers

There are two ways to register consumers: decorators and config. Both can be
used simultaneously and produce the same result at runtime. The library
validates that no duplicate queue names exist across both sources.

All queues are created as [quorum queues](https://www.rabbitmq.com/docs/quorum-queues)
by default. Consumers do not create exchanges, they only bind to exchanges
that already exist (declared via `assertExchanges`).

### Decorator-based consumers

Decorate any method with `@RabbitConsumer()` and the library will
automatically discover and wire it up during application bootstrap.
This is the recommended approach for most use cases since it keeps the
consumer logic located with the handler.

```typescript
import { Injectable } from '@nestjs/common';
import { RabbitConsumer, ConsumerOptions, MessageParams } from '@bgaldino/nestjs-rabbitmq';

@Injectable()
export class OrderService {
  @RabbitConsumer({
    queue: 'order.created',
    exchangeName: 'orders',
    routingKey: 'order.created',
    prefetch: 5,
  })
  async handleOrderCreated(content: OrderPayload, params?: MessageParams) {
    // handle message
  }
}
```

The provider must be registered in a NestJS module. The library scans all
providers and controllers for decorated methods.

### Config-based consumers

If you prefer centralized configuration, or need to conditionally register
consumers based on environment, you can use the `consumerChannels` array.
The `defineRabbitConsumer` helper provides type safety:

```typescript
import { defineRabbitConsumer } from '@bgaldino/nestjs-rabbitmq';

RabbitMQModule.forRoot({
  connectionString: 'amqp://localhost',
  delayExchangeName: 'my_app',
  assertExchanges: [{ name: 'orders', type: 'topic' }],
  consumerChannels: [
    defineRabbitConsumer({
      queue: 'order.created',
      exchangeName: 'orders',
      routingKey: 'order.created',
      prefetch: 5,
      handler: {
        provider: OrderService,
        methodName: 'handleOrderCreated',
      },
    }),
  ],
})
```

The library resolves the provider instance automatically. No need to manually
bind `this` or inject the service into your config.

### Mixed usage

Both approaches can coexist. A common pattern is using decorators for static
consumers and config for conditional ones:

```typescript
// Static consumer via decorator
@RabbitConsumer({ queue: 'audit.log', exchangeName: 'events', routingKey: '#' })
async auditLog(content: any) { ... }

// Conditional consumer via config
consumerChannels: isProduction ? [
  defineRabbitConsumer({ queue: 'debug.trace', ... })
] : [],
```

### Handler signature

Every consumer handler follows the same signature regardless of registration
method:

```typescript
async handler(content: T, params?: MessageParams): Promise<void>;
```

The `MessageParams` object is optional and contains:

```typescript
type MessageParams = {
  message: ConsumeMessage;
  channel: ConfirmChannel;
  queue: string;
  originalRoutingKey?: string;
};
```

The `content` parameter is the parsed message body. The library automatically
attempts to parse the message as JSON. If parsing fails, the raw string is
passed instead.

You can implement the `ConsumerHandler<T>` interface to strongly type your
consumer:

```typescript
import { ConsumerHandler, MessageParams } from '@bgaldino/nestjs-rabbitmq';

@Injectable()
export class OrderService implements ConsumerHandler<OrderPayload> {
  async messageHandler(content: OrderPayload, params?: MessageParams): Promise<void> {
    console.log(content.orderId);
  }
}
```

### Consumer groups

Groups allow you to control which consumers are enabled on a given deployment.
This is useful when multiple instances of the same application serve different
roles.

```typescript
@RabbitConsumer({
  queue: 'heavy.processing',
  exchangeName: 'jobs',
  routingKey: 'heavy.*',
  group: 'workers',
})
async processHeavyJob(content: any) { ... }
```

The active group is determined by:

1. The `RMQ_CONSUMER_GROUP` environment variable (highest priority)
2. The `group` parameter passed to `createConsumers(group)`
3. Defaults to `"rabbit-default"`

Consumers without an explicit group are assigned to the active group and will
always be initialized. Consumers with a group that does not match the active
group are skipped.

## Publishers

### Publishing messages

Inject `RabbitMQService` and call `publish()`:

```typescript
import { Injectable } from '@nestjs/common';
import { RabbitMQService } from '@bgaldino/nestjs-rabbitmq';

@Injectable()
export class OrderService {
  constructor(private readonly rabbit: RabbitMQService) {}

  async createOrder(order: Order) {
    const published = await this.rabbit.publish('orders', 'order.created', order);

    if (!published) {
      // handle publish failure
    }
  }
}
```

The `publish()` method uses [Publisher Confirms](https://www.rabbitmq.com/docs/confirms#publisher-confirms)
to guarantee the message was delivered to the broker before resolving the
promise. Returns `true` on success, `false` on failure.

### Typed publishing

You can pass a generic type to enforce the message shape at compile time:

```typescript
await this.rabbit.publish<OrderPayload>('orders', 'order.created', {
  orderId: '123',
  amount: 99.90,
});
```

You can also pass custom publish options as a fourth argument, such as
additional headers or properties.

## Multi-vhost Connections

If your application needs to consume from or publish to multiple RabbitMQ
vhosts (or entirely different brokers), you can use named connections.
Each connection is a self-contained unit with its own `connectionString`,
`delayExchangeName`, `assertExchanges`, and `consumerChannels`.

### Named connections

Replace the flat connection fields with a `connections` array. Each entry
must have a unique `name`:

```typescript
import { RabbitMQModule, ConnectionConfig } from '@bgaldino/nestjs-rabbitmq';

RabbitMQModule.forRoot({
  connections: [
    {
      name: 'default',
      connectionString: 'amqp://localhost/main',
      delayExchangeName: 'my_app',
      assertExchanges: [{ name: 'orders', type: 'topic' }],
    },
    {
      name: 'shared-bus',
      connectionString: 'amqp://localhost/shared',
      delayExchangeName: 'shared_app',
      assertExchanges: [{ name: 'events', type: 'topic' }],
    },
  ],
})
```

The flat shorthand (`connectionString` at the root level) still works for
single-connection setups. Internally it becomes a connection named
`"default"`. You cannot set both `connectionString` and `connections` at the
same time.

### Targeting a connection from consumers

Add the `connection` field to `@RabbitConsumer()` or to a config-based
consumer to specify which connection it should attach to. If omitted,
it defaults to `"default"`:

```typescript
@RabbitConsumer({
  queue: 'events.audit',
  exchangeName: 'events',
  routingKey: '#',
  connection: 'shared-bus',
})
async auditEvents(content: any) { ... }
```

Config-based consumers declared inside a connection's `consumerChannels` are
automatically scoped to that connection:

```typescript
connections: [
  {
    name: 'default',
    connectionString: 'amqp://localhost/main',
    delayExchangeName: 'my_app',
    assertExchanges: [{ name: 'orders', type: 'topic' }],
    consumerChannels: [
      defineRabbitConsumer({
        queue: 'order.created',
        exchangeName: 'orders',
        routingKey: 'order.created',
        handler: { provider: OrderService, methodName: 'handleOrderCreated' },
      }),
    ],
  },
],
```

### Publishing to a specific connection

Pass the `connection` option to `publish()`:

```typescript
await this.rabbit.publish('events', 'audit.created', payload, {
  connection: 'shared-bus',
});
```

When omitted, the message is published to the `"default"` connection.

## Retry Strategy

Each consumer can define a `retryStrategy` to handle transient failures. When
the handler throws an error, the message is published to a retry queue
(`{queue}.retry`) with a TTL. Once the TTL expires, the message is routed
back to the original queue for another attempt.

```typescript
@RabbitConsumer({
  queue: 'order.process',
  exchangeName: 'orders',
  routingKey: 'order.process',
  retryStrategy: {
    enabled: true,
    maxAttempts: 5,
    delay: (content, attempt, error) => attempt * 5000,
  },
})
async processOrder(content: OrderPayload) { ... }
```

The `delay` callback receives the message content, the current attempt number,
and the error that was thrown. It should return the delay in milliseconds
before the next retry. The return value controls the behavior:

- A positive number: the message is sent to the retry queue with that TTL
- Zero: the message is retried immediately (republished to the end of the
  original queue)
- A negative number: retrying is skipped entirely, and the message goes
  straight to the dead letter strategy

**Defaults** (when `retryStrategy` is not specified):

- `enabled`: true
- `maxAttempts`: 5
- `delay`: () => 5000

When the maximum number of attempts is reached, the message is nacked and sent
to the dead letter queue.

## Dead Letter Strategy

Each consumer can define a `deadLetterStrategy` to control what happens when
a message exhausts all retry attempts:

```typescript
@RabbitConsumer({
  queue: 'order.process',
  exchangeName: 'orders',
  routingKey: 'order.process',
  deadLetterStrategy: {
    suffix: '.dlq',
    callback: async (content) => {
      await alertService.notify('Order processing failed', content);
      return true;
    },
  },
})
async processOrder(content: OrderPayload) { ... }
```

The `suffix` controls the name of the dead letter queue. Defaults to `.dlq`,
resulting in a queue named `{queue}.dlq`.

The `callback` is executed before sending the message to the DLQ. It receives
the raw message content and should return a boolean:

- `true`: the message is forwarded to the DLQ after the callback executes
- `false`: the message is acknowledged and dropped, it will not go to the DLQ

If the callback throws an error, the message is forwarded to the DLQ regardless.

## Disabling the automatic ack

By default, the consumer automatically acknowledges the message after the
handler completes. If you need manual control over acknowledgement, disable it:

```typescript
@RabbitConsumer({
  queue: 'order.process',
  exchangeName: 'orders',
  routingKey: 'order.process',
  autoAck: false,
})
async processOrder(content: OrderPayload, params: MessageParams) {
  // do work
  params.channel.ack(params.message);
}
```

When `autoAck` is disabled, you are responsible for calling `channel.ack()` or
`channel.nack()`. If you do not acknowledge the message, it will remain
unacknowledged and RabbitMQ will redeliver it when the consumer disconnects.

## Custom Header Metadata

Every published message includes the following custom headers automatically:

```json
{
  "x-original-exchange": "exchange_name",
  "x-original-routing-key": "routing.key",
  "x-published-at": "2026-01-01T00:00:00.000Z"
}
```

These headers preserve the original exchange and routing key references, which
would otherwise be lost when a message is routed through retry queues or the
DLQ.

The `originalRoutingKey` field in `MessageParams` is derived from these headers
when available, falling back to the message's current routing key.

## Extra Options

### Consumer manual loading

Consumers are attached during the `OnApplicationBootstrap` lifecycle, which
means the application begins receiving messages as soon as all modules are
initialized, but before `app.listen()` resolves.

If you need consumers to start only after the HTTP server is ready (or need
to defer startup for any other reason), set `consumerManualLoad: true` and
call the initialization manually:

```typescript
RabbitMQModule.forRoot({
  connectionString: 'amqp://localhost',
  delayExchangeName: 'my_app',
  assertExchanges: [],
  extraOptions: {
    consumerManualLoad: true,
  },
})
```

```typescript
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(3000);

  const rabbit = app.get(RabbitMQService);
  await rabbit.startConsumers();
}
bootstrap();
```

You can also pass a group name to `startConsumers(group)` to initialize only consumers
belonging to that group.

### Message inspection and logging

You can inspect consumer and publisher messages by setting `extraOptions.logType`
or the `RABBITMQ_LOG_TYPE` environment variable to one of:

- `all` — logs both consumer and publisher messages
- `consumer` — logs consumer messages only
- `publisher` — logs publisher messages only
- `none` — no message logging (default)

The environment variable takes precedence over the config value.

Consumer errors are always logged regardless of this setting.

### Health check

You can check the connection status of both the consumer and publisher
connections:

```typescript
const rabbit = app.get(RabbitMQService);

// Check all connections (returns 0 if any connection is offline)
const status = rabbit.checkHealth(); // 1 = online, 0 = offline

// Check a specific connection
const sharedStatus = rabbit.checkHealth('shared-bus');
```

## Building locally

```shell
pnpm install
pnpm build
```

## License

[MIT License](https://github.com/brunogaldino/nestjs-rabbitmq/blob/master/LICENSE)
