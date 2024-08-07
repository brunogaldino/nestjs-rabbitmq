# @nestjs-rabbitmq

# @DEPRECATED

<!--toc:start-->

- [@nestjs-rabbitmq](#nestjs-rabbitmq)
  - [Descrição](#descrição)
  - [Gerenciamento de Conexão](#gerenciamento-de-conexão)
  - [Uso](#uso)
    - [Desenvolvimento local](#desenvolvimento-local)
    - [Instalação](#instalação)
    - [Inicialização do Módulo](#inicialização-do-módulo)
  - [O arquivo de configuração](#o-arquivo-de-configuração)
  - [Publicadores](#publicadores)
    - [Declarando publicadores](#declarando-publicadores)
    - [Injetando o RabbitMQService](#injetando-o-rabbitmqservice)
    - [Publicando mensagens](#publicando-mensagens)
  - [Consumidores](#consumidores)
    - [Declarando consumidores](#declarando-consumidores)
      - [Injetando a função messageHandler](#injetando-a-função-messagehandler)
      - [Declarando o consumidor](#declarando-o-consumidor)
      - [O parâmetro retryStrategy](#o-parâmetro-retrystrategy)
      - [A propriedade autoAck](#a-propriedade-autoack)
  - [Inspeção de messagens](#inspeção-de-messagens)
  - [Como buildar esta biblioteca?](#como-buildar-esta-biblioteca)
  <!--toc:end-->

## Descrição

Este módulo apresenta uma maneira opinativa de inicializar e configurar o Publisher/Subscriber do RabbitMQ usando o NestJS.

## Gerenciamento de Conexão

Este pacote utiliza fortemente o [`amqp-connection-manager`](https://github.com/benbria/node-amqp-connection-manager) para gerenciar a conexão com o RabbitMQ.

Ao iniciar uma conexão, é criada uma instância de AmqpConnectionManager, passando as seguintes informações:

```typescript
this.connection = connect(options.connectionString, {
  heartbeatIntervalInSeconds: 60,
  reconnectTimeInSeconds: 5,
  connectionOptions: {
    keepAlive: true,
    keepAliveDelay: 5000,
    servername: hostname(),
    clientProperties: {
      connection_name: `${process.env.npm_package_name}-${hostname()}`,
    },
  },
});
```

Esta conexão é então utilizada para criar quaisquer canais necessários para consumidores registrados e um único canal para publicar mensagens, portanto, apenas UMA conexão é criada ao longo de todo o ciclo de vida do SDK.

## Uso

### Desenvolvimento local

crie um arquivo local chamado `Dockerfile.rabbitmq` e cole o conteúdo a seguir

```Dockerfile
FROM rabbitmq:3.13.1-management

# Instalação do pacote curl
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Baixa e habilita o plugin rabbitmq_delayed_message_exchange
RUN curl -L https://github.com/rabbitmq/rabbitmq-delayed-message-exchange/releases/download/v3.13.0/rabbitmq_delayed_message_exchange-3.13.0.ez > $RABBITMQ_HOME/plugins/rabbitmq_delayed_message_exchange-3.13.0.ez && \
    rabbitmq-plugins enable --offline rabbitmq_delayed_message_exchange

# Define o usuário e senha padrão do RabbitMQ
ENV RABBITMQ_DEFAULT_USER=admin
ENV RABBITMQ_DEFAULT_PASS=admin

```

PS.: Esse Dockerfile já está preparado para habilitar o pluggin rabbitmq_delayed_message_exchange, conforme utilizado nos nossos ambientes em nuvem.

Agora, na pasta onde o arquivo foi criado, execute o comando:

```shell
docker build -t rabbitmq:latest -f Dockerfile.rabbitmq .
```

Isso irá construir a imagem do RabbitMQ usando o Dockerfile.rabbitmq e atribuir a tag "rabbitmq:latest" à imagem.

Depois de construir a imagem, você pode iniciar um contêiner com base nessa imagem. Certifique-se de definir as variáveis de ambiente conforme necessário:

```shell
docker run -d --name rabbitmq \
  -e RABBITMQ_DEFAULT_USER=admin \
  -e RABBITMQ_DEFAULT_PASS=admin \
  -v ./data_docker/rabbitmq/data/:/var/lib/rabbitmq/ \
  -p 5672:5672 -p 15672:15672 \
  rabbitmq:latest
```

Neste comando:

-d inicia o contêiner em segundo plano.
--name meu-rabbitmq define o nome do contêiner como "meu-rabbitmq".
-e RABBITMQ_DEFAULT_USER=admin e -e RABBITMQ_DEFAULT_PASS=admin definem as variáveis de ambiente para o usuário e senha padrão do RabbitMQ.
-v /caminho/para/data_docker/rabbitmq/data/:/var/lib/rabbitmq/ monta o volume para persistir os dados do RabbitMQ.
-p 5672:5672 -p 15672:15672 mapeia as portas do RabbitMQ (5672 para mensagens e 15672 para o painel de administração).

### Instalação

```shell
yarn add @nestjs-rabbitmq
```

### Inicialização do Módulo

Importe e adicione o `RabbitMQModule` ao seu `app.module.ts` e chame o método `register()` para ativá-lo.

```typescript
import { RabbitMQModule } from './rabbit/rabbitmq.module';
import { RabbitOptions } from './rabbit.options';

@Module({
  imports: [
    ...
    RabbitMQModule.register({ useClass: RabbitOptions, imports: [...] }),
    ...
  ]
})
export class AppModule {}
```

O módulo `RabbitMQModule` é marcado como **@Global**, portanto, não é necessário fazer mais injeções de módulo para usar o `RabbitMQService`.

## O arquivo de configuração

Este SDK depende muito de um único padrão de configuração para configurar corretamente os publicadores/consumidores do RabbitMQ. O arquivo de configuração mínimo precisa conter o seguinte:

```typescript
@Injectable()
export class RabbitOptions implements RabbitOptionsFactory {
  createRabbitOptions(): RabbitMQModuleOptions {
    return {
      connectionString: "amqp://{user}:{password}@{url}/{vhost}",
      publishChannels: [],
      consumerChannels: [],
    };
  }
}
```

## Publicadores

### Declarando publicadores

A propriedade `publishChannels` espera um array de `RabbitMQAssertExchange` que será asserido durante o inicialização do Nest.

Por exemplo:

```typescript
publishChannels: [
  { name: 'webhooks', type: 'topic',options: { durable: true, autoDelete: false } },
  { name: 'webhooks', type: 'topic',options: { durable: true, autoDelete: false, exchangeSufix: 'my-exchange' } },
  { name: 'test-fanout', type: 'fanout' },
  { name: 'example-direct', type: 'direct' },
],
```

Observe que agora há a possibilidade de configurar manualmente a propriedade exchangeSufix, por default o valor é '.exchange', caso necessário é possível configurar manualmente o sufixo conforme exemplo da linha 2.

Caso a exchange não exista no Rabbit ela será criada no momento da incialização do Nest.

Cada entrada do array será validada com base nos parâmetros fornecidos. Se uma exchange já existir com parâmetros diferentes, uma exceção terminal `406 - PRECONDITION_FAILED` será lançada e o Nest não inicializará.

### Injetando o RabbitMQService

O `RabbitMQModule` fornece seu próprio serviço `RabbitMQService` que estará globalmente disponível através do sistema de injeção de dependência do Nest. Basta exigir isso no construtor de qualquer Controlador ou Serviço do Nest.

```typescript
@Controller()
export class MyClassController {
  constructor(private readonly rabbitMQService: RabbitMQService) {}
}
```

### Publicando mensagens

Para publicar mensagens, utilize o método `publish` fornecido pelo `RabbitMQService`, que possui a seguinte assinatura:

```typescript
public async publish<T = any>(
  exchangeName: string,
  routingKey: string,
  message: T,
  options?: PublishOptions,
): Promise<boolean>
```

Por exemplo:

```typescript
await this.rabbitMQClient.publish<CustomModel>(
  "some-exchange",
  "routing-key",
  {},
);
```

É importante notar que o método `publish` retorna um `Promise<boolean>` ao utilizar Confirmações de Publicador do RabbitMQ [Publisher Confirms](https://www.rabbitmq.com/docs/confirms). Isso garante que a mensagem publicada seja confirmada pelo corretor antes de resolver a promessa.

## Consumidores

### Declarando consumidores

No arquivo de configuração, todos os consumidores devem ser declarados na seção `consumerChannels`. A lista de objetos do tipo `RabbitMQConsumerChannel` será então asserida e a fila e quaisquer vinculações necessárias serão criadas com base nas instruções do objeto.

Por exemplo:

```typescript
 consumerChannels: [
       {
         options: {
           queue: 'direct-consumer-1', //Nome da queue
           exchangeName: 'example-direct', //Nome da exchange "sempre terminando com .exchange"
           routingKey: 'direct-1', // Routing Key que sera criada no bind
           prefetch: 10, //Quantidade máxima de mensagens que o RabbitMQ irá entregar para um consumer
           autoDelete: false, //Se a fila será automaticamente deletada caso não haja mais consumidores
           durable: true, //Se a fila irá persistir as mensagens em disco
           autoAck: true, //Ack automatico após o retorno do messageHandler. Se falso, é necessário dar um ack manual
           retryStrategy: {
             enabled: true, //Se a fila terá retentativa e criará as filas de .retry e .dlq
             maxAttempts: 5, //Quantidade de tentativas maximas antes de enviar para
             delay: 5000,
           },
          suffixOptions?: { // parâmetros opcionais para configuração manual do nome da exchange e da DLQ.
            exchangeSuffix?: string; // o valor default é '.exchange', caso necessário é possível configurá-lo manualmente
            dlqSuffix?: string; // o valor default é '.dlq', caso necessário é possível configurá-lo manualmente
          };
         },
         messageHandler: this.rabbitConsumersExample.directMessageHandler.bind(this.rabbitConsumersExample),
       }
]
```

Caso a exchange não exista no host que está sendo configurado para a conexão será necessário criar-lá manualmente. Atente-se para as demais configurações.

Os consumidores **NÃO** criam nem fazer asserts de exchanges. Esteja ciente do que você está conectando e como a conexão está sendo feita. Alguns exemplos são:

- Exchanges `fanout` ignoram routingKeys.
- Exchanges `direct` não podem usar routing keys genéricas.
- Exchanges tópicos podem usar `#` e `*` nas chaves de roteamento para criar vinculações genéricas.

#### Injetando a função messageHandler

E como você pode ver no exemplo acima, a propriedade `messageHandler` espera o callback do consumidor do tipo `IRabbitHandler`. É importante chamar o `.bind(service)` nele para que possa anexar o contexto `this` do serviço à função.
Para anexar a função corretamente, o módulo que contém o consumidor precisa ser injetado através do `.register({imports: [RabbitConsumersExample]})`.

Cada módulo então estará disponível para ser injetado no arquivo de configuração, por exemplo:

```typescript
export class RabbitOptions implements RabbitOptionsFactory {
  constructor(
    @Inject(forwardRef(() => RabbitConsumersExample))
    readonly rabbitConsumersExample: RabbitConsumersExample,
  ) {}
...
}
```

É importante observar o uso do método `forwardRef()`. Isso é **necessário** no caso de a classe que possui o consumidor também possuir um publicador! Porque, como mencionado anteriormente, a classe que possui um produtor precisa injetar o serviço RabbitMQService, e se esta classe também precisar ser injetada no contexto do RabbitMQ, uma dependência circular será criada entre elas. O [forwardRef()](https://docs.nestjs.com/fundamentals/circular-dependency) quebra o loop.

#### Declarando o consumidor

Para declarar o consumidor, basta criar uma função com a seguinte assinatura:

```typescript
  async myFunction(message: ConsumeMessage, channel: ConfirmChannel, queue: string): Promise<void>;
```

Você também pode optar por implementar a interface `IRabbitConsumer` na sua classe desejada, por exemplo:

```typescript
export class MyClass implements IRabbitConsumer {
  public async messageHandler(
    message: ConsumeMessage,
    channel: ConfirmChannel,
    queue: string,
  ): Promise<void> {}
}
```

Isso é apenas um auxílio para que você tenha pelo menos um consumidor funcional, você pode criar quantos quiser, desde que siga as regras de vinculação no arquivo de configuração.

#### O parâmetro retryStrategy

Dentro da declaração do consumidor há uma propriedade opcional chamada `retryStrategy` que dita se haverá um mecanismo de retry e DLQ. Por padrão, a estratégia de retry padrão é (no caso de omitido):

```typescript
retryStrategy: {
  enabled: true;
  maxAttempts: 5;
  delay: 5000;
}
```

Quando ativada, a fila principal também criará uma fila `.retry` e uma fila `.dlq`. Se uma exceção for **lançada** durante a execução do consumidor sem ser capturada, o mecanismo de retry automaticamente enfileirará a mensagem lançada na fila `.retry` pelo tempo de atraso especificado, até o máximo de tentativas declaradas. Se o consumidor não puder processar a mensagem, ela será enviada para a fila `.dlq`.

#### A propriedade autoAck

Por padrão, você não precisa confirmar a mensagem consumida por meio de um `ack`, isso será feito automaticamente pelo SDK no retorno do callback do consumidor. Se por algum motivo você precisar fazer o processo manualmente, você pode passar `autoAck: false` ela interromperá a confirmação da mensagem no retorno do callback.
**Atenção**: Se a propriedade `autoAck` estiver desativada, é **necessário** que o consumidor confirme a mensagem manualmente, por exemplo:

```typescript
public async messageHandler(message: ConsumeMessage, channel: ConfirmChannel, queue: string): Promise<void> {
   channel.ack(message);
}
```

## Inspeção de messagens

Essa biblioteca providencia uma ferramente de inspeção de mensagens para debugging e monitoramento. Para ativar esse, coloque em seu arquivo de configuração:

```typescript
{
  ...,
  trafficInspection: "all" | "consumer" | "producer" | "none";
}
```

Essa opção pode ser sobreescrita com o uso da variável de ambiente: `RABBITMQ_TRAFFIC_TYPE` aceitando os mesmos valores.

Por padrão, o valor `none` será usado.

## Como buildar esta biblioteca?

Certifique-se de ter a última versão do Yarn instalada e execute o seguinte comando:

```typescript
yarn build
```
