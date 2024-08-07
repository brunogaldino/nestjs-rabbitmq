# @bgaldino/nestjs-rabbitmq

# Table of Contents

<!--toc:start-->

- [@bgaldino/nestjs-rabbitmq](#bgaldinonestjs-rabbitmq)
- [Table of Contents](#table-of-contents)
  - [Description](#description)
    - [Requirements](#requirements)
    - [Instalation](#instalation)
  - [Getting Started](#getting-started)
    - [Importing the module](#importing-the-module)
    - [The configuration file](#the-configuration-file)
  - [Publishers](#publishers)
    - [Publishing messages](#publishing-messages)
  - [Consumers](#consumers)
    - [The messageHandler callback](#the-messagehandler-callback)
    - [Strongly typed consumer](#strongly-typed-consumer)
    - [Consumer late loading](#consumer-late-loading)
    - [Declaration example](#declaration-example)
  - [Retrying strategy](#retrying-strategy)
  - [Disabling the automatic ack](#disabling-the-automatic-ack)
  - [Message inspection and logging](#message-inspection-and-logging)
  - [How to build this library locally ?](#how-to-build-this-library-locally)
- [License](#license)
<!--toc:end-->

## Description

This module features an opinionated way of configuring the RabbitMQ connection
by using a configuration file that describes the behaviour of all publishers
and consumers present in your project

### Requirements

- @nestjs/common: ">9"
- An RabbitMQ instance with the
  [RabbitMQ Delayed Message Plugin](https://github.com/rabbitmq/rabbitmq-delayed-message-exchange) installed

### Instalation

**PNPM**

```shell
pnpm add @nestjs-rabbitmq
```

**YARN**

```shell
yarn add @nestjs-rabbitmq
```

**NPM**

```shell
npm add @nestjs-rabbitmq
```

<!-- ## Connection Management -->
<!---->
<!-- This package wraps around the [`amqp-connection-manager`](https://github.com/benbria/node-amqp-connection-manager) -->
<!-- to manage all AMQP connections with RabbitMQ -->
<!---->
<!-- When starting a connection, an instance of `AmqpConnectionManager` is created, passing the following information: -->
<!---->
<!-- ```typescript -->
<!-- this.connection = connect(options.connectionString, { -->
<!--   heartbeatIntervalInSeconds: 60, -->
<!--   reconnectTimeInSeconds: 5, -->
<!--   connectionOptions: { -->
<!--     keepAlive: true, -->
<!--     keepAliveDelay: 5000, -->
<!--     servername: hostname(), -->
<!--     clientProperties: { -->
<!--       connection_name: `${process.env.npm_package_name}-${hostname()}`, -->
<!--     }, -->
<!--   }, -->
<!-- }); -->
<!-- ```` -->

<!-- Esta conexão é então utilizada para criar quaisquer canais necessários para consumidores registrados e um único canal para publicar mensagens, portanto, apenas UMA conexão é criada ao longo de todo o ciclo de vida do SDK. -->

## Getting Started

### Importing the module

Import the `RabbitMQModule` in your `app.module.ts` and call the method `register({})`

```typescript
import { RabbitMQModule } from '@bgaldino/nestjs-rabbitmq';
import { RabbitOptions } from '@bgaldino/nestjs-rabbitmq';

@Module({
  imports: [
    ...
    RabbitMQModule.register({ useClass: RabbitOptions, injects: [...] }),
    ...
  ]
})
export class AppModule {}
```

The `RabbitMQModule` is marked as `@Global`, therefore, calling it once is enough
to allow the injection of the `RabbitMQService`

### The configuration file

Create a `rabbitmq.config.ts` or whatever the name you prefer containing the minimum configuration:

```typescript
import { Injectable } from "@nestjs/common";
import {
  RabbitMQModuleOptions,
  RabbitOptionsFactory,
} from "@bgaldino/nestjs-rabbitmq";

@Injectable()
export class RabbitOptions implements RabbitOptionsFactory {
  createRabbitOptions(): RabbitMQModuleOptions {
    return {
      connectionString: "amqp://{user}:{password}@{url}/{vhost}",
      delayExchangeName: "MyDelayExchange",
      assertExchanges: [],
      consumerChannels: [],
    };
  }
}
```

## Publishers

**Example config file**:

```typescript
assertExchanges: [
  { name: 'webhooks', type: 'topic',options: { durable: true, autoDelete: false } },
  { name: 'test-fanout', type: 'fanout' },
  { name: 'example-direct', type: 'direct', , options: {exchangeSuffix: '.mySufix'}},
],
```

The `assertExchanges` property expects an array of `RabbitMQAssertExchange`
and each entry will asserted against the RabbitMQ connected server.

If any entry does not match a current configuration, or cannot be
created/attached. A terminal error `406 - PRECONDITION_FAILED` will be thrown
with the reason and the server will not initialize

By default every exchange will have the `.exchange` attached to its name.
If you want to remove this, you can pass an empty value to the
`exchangeSuffix` property

### Publishing messages

**Example**:

```typescript
import { Injectable } from "@nestjs/common";
import { RabbitMQService } from "@bgaldino/nestjs-rabbitmq";

@Injectable()
export class MyService {
  constructor(private readonly rabbitMQService: RabbitMQService) {}
}

async publishMe(){
  const isPublished = await this.rabbitMQService.publish('exchange_name', 'routing_key', {});
}

//or

async publishMeTyped() {
  const isPublished = await this.rabbitMQService.publish<CustomType>('exchange_name', 'routing_key', {});
  //This will return an error if the object is not properly typed
}
```

The `publish()` method uses [Publish Confirms](https://www.rabbitmq.com/docs/confirms#publisher-confirms)
to make sure that the message is delivered to the broker before returning
the promise.

## Consumers

Inside the configuration file you can declare your consumers on the section
`consumerChannels`. This list of `RabbitMQConsumerChannel` will be evaluated
and each entry will try to create the queue and bind it to the declared
exchange.

**Example:**

```typescript

createRabbitOptions(): RabbitMQModuleOptions {
    return {
      ...,
      consumerChannels: [
        {
          options: {
            queue: 'myqueue',
            exchangeName: 'foobar.exchange',
            routingKey: 'myqueue',
            prefetch: Number(process.env.RABBIT_PREFETCH ?? 10),
            retryStrategy: {
              enabled: true,
              maxAttempts: 5,
              delay: (attempt: number) => {
                return attempt * 5000;
              },
            },
          },
          messageHandler: this.consumerService.messageHandler.bind(
            this.consumerService,
          ),
        },
      ]
  }
}
```

The consumer **DOES NOT** create exchanges and only bind to ones that already
exists. This is to avoid creating exchanges with typos and misconfigurations.

### The messageHandler callback

As declared in the example above, the `messageHandler` property expects a
callback of the type `IRabbitHandler`. Because of the nature of the library,
we will need to call the `.bind(this.yourService)` in order to bind the `this`
context of the origin service to the callback.

The `RabbitMQModule.register()` accepts an array of NestJS Modules with the
any module that contains an consumer callback function.

The `callback` has the following signature:

```typescript
async messageHandler(content: any, params?: RabbitConsumerParams): Promise<void>;
```

where `RabbitConsumerParams` is optional and contains the following info:

```typescript
export type RabbitConsumerParameters = {
  message: ConsumeMessage;
  channel: ConfirmChannel;
  queue: string;
};
```

### Strongly typed consumer

You can use the `IRabbitConsumer<T>` to type the consumer first parameter `content`.

```typescript
export interface MyInterface {
  type: string;
  id: number;
}

@Injectable()
export class MyClass implements IRabbitConsumer<MyInterface> {
  public async messageHandler(content: MyInterface): Promise<void> {
    console.log(content.type);
  }
}
```

### Consumer late loading

This library attaches the consumers during the `OnApplicationBootstrap` lifecycle
of the NestJS Application, meaning that the application will begin to receive
messages as soon as the lifecycle is done.

If your application needs some time to initiate the consumers for some reason,
(pods with limited resource for example), you can set the flag
`consumerManualLoad: true` on the configuration file and manually call the
consumer instantiation.

**Example:**

```typescript
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(3000);

  const rabbit: RabbitMQService = app.get(RabbitMQService);
  await rabbit.createConsumers();
}
bootstrap();
```

### Declaration example

**Service example:**

```typescript
//consumer.module.ts
@Module({
  provides: [ConsumerService],
  exports: [ConsumerService],
})
export class ConsumerModule {}

//consumer.service.ts
@Injectable()
export class ConsumerService {
  async messageHandler(content: any) {
    return null;
  }
}
```

**Config Example:**

```typescript
//rabbit.config.ts
@Injectable()
export class RabbitOptions implements RabbitOptionsFactory {
  constructor(
    readonly consumerService: ConsumerService ,
  ) {}

createRabbitOptions(): RabbitMQModuleOptions {
  return {
        ...
        consumerchannels: [
          {
            options: {
              queue: "myqueue",
              exchangename: "test.exchange",
              routingkey: "myqueue",
              prefetch: number(process.env.rabbit_prefetch ?? 10),
            },
            messagehandler: this.MyService.messageHandler.bind(this.MyService),
          },
        ];
    }
}

//app.module.ts
@Module({
  imports: [
  ...,
  RabbitMQModule.register({
    useClass: RabbitConfig,
    injects: [ConsumerModule]
  })
  ]
})
export class AppModule {}
```

## Retrying strategy

On each consumer declaration you can pass the optional parameter: `retryStrategy`
with following the contract:

```typescript
retryStrategy: {
  enabled?: true,
  maxAttempts?: 5,
  delay?: (attempt) => {return attempt * 5000};
}
```

By default, the `retryStrategy` is enabled. When consuming a new message and
the callback throws an error.

When enabled, the library will create a `{options.queue}.dlq` queue and will use
the `delayExchangeName` exchange as the retrying orchestrator where the
`x-delay` value is the return of the anonymous callback `delay`.

When the maximum attempts is reached, the library issues a nack, sending the
message to the `.dlq` queue.

## Disabling the automatic ack

By default, the consumer will automatically send an ack at the end of the
callback execution. If you need to disable this behaviour, you can pass:

```typescript
consumerChannels: [
  options: {
    ...,
    autoAck: false
  }
]
```

When disabled, it is necessary to manually acknowledge the message as follows:

```typescript
public async messageHandler(content: any, params: RabbitConsumerParameters): Promise<void> {
   params.channel.ack(params.message);
}
```

## Message inspection and logging

You can inspect the consumer/publisher messages by setting the parameter
`trafficInspection` or setting the environment variable `RABBITMQ_TRAFFIC_TYPE`
to either: `all | consumer | publisher | none`.

The default value is `none`

## How to build this library locally ?

Just pull the project and run:

```shell
pnpm install
pnpm build
```

And should be good to go

# Planned features

TBD

# Contribute

TBD

# License

[MIT License](https://github.com/golevelup/nestjs/blob/master/LICENSE)
