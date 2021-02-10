import {
  readFileOrUrlWithCache,
  parseInterpolationStrings,
  getInterpolatedHeadersFactory,
  getInterpolatedStringFactory,
  getHeadersObject,
  ResolverDataBasedFactory,
  loadFromModuleExportExpression,
} from '@graphql-mesh/utils';
import { createGraphQLSchema, GraphQLOperationType } from './openapi-to-graphql';
import { Oas3 } from './openapi-to-graphql/types/oas3';
import {
  MeshHandler,
  YamlConfig,
  ResolverData,
  GetMeshSourceOptions,
  MeshSource,
  KeyValueCache,
  MeshPubSub,
} from '@graphql-mesh/types';
import { fetchache, Request } from 'fetchache';
import { set } from 'lodash';
import { OasTitlePathMethodObject } from './openapi-to-graphql/types/options';

export default class OpenAPIHandler implements MeshHandler {
  config: YamlConfig.OpenapiHandler;
  cache: KeyValueCache;
  pubsub: MeshPubSub;
  constructor({ config, cache, pubsub }: GetMeshSourceOptions<YamlConfig.OpenapiHandler>) {
    this.config = config;
    this.cache = cache;
    this.pubsub = pubsub;
  }

  async getMeshSource(): Promise<MeshSource> {
    const path = this.config.source;
    const spec = await readFileOrUrlWithCache<Oas3>(path, this.cache, {
      headers: this.config.schemaHeaders,
      fallbackFormat: this.config.sourceFormat,
    });

    let fetch: WindowOrWorkerGlobalScope['fetch'];
    if (this.config.customFetch) {
      fetch = await loadFromModuleExportExpression(this.config.customFetch as any, 'default');
    } else {
      fetch = (...args) => fetchache(args[0] instanceof Request ? args[0] : new Request(...args), this.cache);
    }

    const baseUrlFactory = getInterpolatedStringFactory(this.config.baseUrl);

    const headersFactory = getInterpolatedHeadersFactory(this.config.operationHeaders);
    const queryStringFactoryMap = new Map<string, ResolverDataBasedFactory<string>>();
    for (const queryName in this.config.qs || {}) {
      queryStringFactoryMap.set(queryName, getInterpolatedStringFactory(this.config.qs[queryName]));
    }
    const searchParamsFactory = (resolverData: ResolverData, searchParams: URLSearchParams) => {
      for (const queryName in this.config.qs || {}) {
        searchParams.set(queryName, queryStringFactoryMap.get(queryName)(resolverData));
      }
      return searchParams;
    };

    const { schema } = await createGraphQLSchema(spec, {
      fetch,
      baseUrl: this.config.baseUrl,
      operationIdFieldNames: true,
      fillEmptyResponses: true,
      includeHttpDetails: this.config.includeHttpDetails,
      genericPayloadArgName:
        this.config.genericPayloadArgName === undefined ? false : this.config.genericPayloadArgName,
      selectQueryOrMutationField:
        this.config.selectQueryOrMutationField === undefined
          ? {}
          : this.config.selectQueryOrMutationField.reduce((acc, curr) => {
              let operationType: GraphQLOperationType;
              switch (curr.type) {
                case 'Query':
                  operationType = GraphQLOperationType.Query;
                  break;
                case 'Mutation':
                  operationType = GraphQLOperationType.Mutation;
                  break;
              }
              set(acc, `${curr.title}.${curr.path}.${curr.method}`, operationType);
              return acc;
            }, {} as OasTitlePathMethodObject<GraphQLOperationType>),
      addLimitArgument: this.config.addLimitArgument === undefined ? true : this.config.addLimitArgument,
      sendOAuthTokenInQuery: true,
      viewer: false,
      equivalentToMessages: true,
      pubsub: this.pubsub,
      resolverMiddleware: (getResolverParams, originalFactory) => (root, args, context, info: any) => {
        const resolverData: ResolverData = { root, args, context, info };
        const resolverParams = getResolverParams();
        resolverParams.requestOptions = {
          headers: getHeadersObject(headersFactory(resolverData)),
        };

        /* FIXME: baseUrl is coming from Fastify Request
        if (context?.baseUrl) {
          resolverParams.baseUrl = context.baseUrl;
        }
        */

        if (!resolverParams.baseUrl && this.config.baseUrl) {
          resolverParams.baseUrl = baseUrlFactory(resolverData);
        }

        if (resolverParams.baseUrl) {
          const urlObj = new URL(resolverParams.baseUrl);
          searchParamsFactory(resolverData, urlObj.searchParams);
        } /* else {
          console.warn(
            `There is no 'baseUrl' defined for this OpenAPI definition. We recommend you to define one manually!`
          );
        } */

        if (context?.fetch) {
          resolverParams.fetch = context.fetch;
        }

        if (context?.qs) {
          resolverParams.qs = context.qs;
        }

        return originalFactory(() => resolverParams)(root, args, context, info);
      },
    });

    const { args, contextVariables } = parseInterpolationStrings(Object.values(this.config.operationHeaders || {}));

    const rootFields = [
      ...Object.values(schema.getQueryType()?.getFields() || {}),
      ...Object.values(schema.getMutationType()?.getFields() || {}),
      ...Object.values(schema.getSubscriptionType()?.getFields() || {}),
    ];

    for (const rootField of rootFields) {
      for (const argName in args) {
        const argConfig = args[argName];
        rootField.args.push({
          name: argName,
          description: undefined,
          defaultValue: undefined,
          extensions: undefined,
          astNode: undefined,
          deprecationReason: undefined,
          ...argConfig,
        });
      }
    }

    contextVariables.push('fetch' /*, 'baseUrl' */);

    return {
      schema,
      contextVariables,
    };
  }
}
