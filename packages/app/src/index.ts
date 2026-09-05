export { SCOPES, DEFAULT_SCOPE, SCOPE_LIFETIME_RANK, isScopeViolation } from "./scope";
export type { Scope } from "./scope";
export type {
  Aspect,
  AspectContext,
  AspectKind,
  AspectNext,
  CommandAspect,
  JobAspect,
  RouteAspect,
} from "./aspect";
export { InjectionToken } from "./token";
export type { InjectionTokenOptions } from "./token";
export {
  flattenProviders,
  isEnvironmentProviders,
  isClassProvider,
  isExistingProvider,
  isFactoryProvider,
  isValueProvider,
  makeEnvironmentProviders,
  provideAppInitializer,
  provideEnvironmentInitializer,
  provideToken,
} from "./provider";
export type {
  ClassProvider,
  EnvironmentProviders,
  ExistingProvider,
  FactoryProvider,
  Provider,
  ProviderDep,
  ProviderDependency,
  Token,
  Type,
  ValueProvider,
} from "./provider";
export {
  Body,
  CanDeactivate,
  Command,
  Controller,
  Data,
  Delete,
  Get,
  Head,
  Headers,
  Host,
  Inject,
  Injectable,
  Job,
  Module,
  Optional,
  Options,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Resolve,
  Self,
  SkipSelf,
  Title,
  UseGuards,
  executeResolvers,
  getCommandMeta,
  getJobMeta,
  getControllerMeta,
  getGuards,
  getHostParams,
  getInjectParams,
  getOptionalParams,
  getRouteParams,
  getSelfParams,
  getSkipSelfParams,
  getInjectableMeta,
  getModuleMeta,
  getQueryMeta,
  getRoutes,
  COMMAND_METADATA,
  JOB_METADATA,
  CONTROLLER_METADATA,
  GUARDS_METADATA,
  CAN_DEACTIVATE_METADATA,
  HOST_PARAMS_METADATA,
  INJECTABLE_METADATA,
  INJECT_PARAMS_METADATA,
  RESOLVE_METADATA,
  OPTIONAL_PARAMS_METADATA,
  ROUTE_PARAMS_METADATA,
  SELF_PARAMS_METADATA,
  SKIP_SELF_PARAMS_METADATA,
  MODULE_METADATA,
  QUERY_METADATA,
  ROUTES_METADATA,
} from "./decorators";
export type {
  CanActivateFn,
  CanDeactivateFn,
  CanMatchFn,
  CommandMeta,
  CommandOptions,
  JobMeta,
  JobOptions,
  ControllerMeta,
  ControllerOptions,
  HttpMethod,
  InjectableMeta,
  InjectableOptions,
  ModuleMeta,
  ModuleOptions,
  ParamOptions,
  QueryMeta,
  QueryOptions,
  ResolveFn,
  RouteDefinition,
  RouteOptions,
  RouteParamBinding,
} from "./decorators";
export { defineModule } from "./module";
export {
  APP_INITIALIZER,
  DB_CLIENT,
  DESTROY_REF,
  ENVIRONMENT_INITIALIZER,
  JOB_CONTEXT,
  REQUEST_CONTEXT,
  createDestroyRef,
} from "./context";
export type { DestroyRef, OnDestroy } from "./context";
export {
  INJECTOR,
  assertInInjectionContext,
  createChildInjector,
  createEnvironmentInjector,
  getActiveInjector,
  inject,
  injectAll,
  injectDestroySignal,
  runInInjectionContext,
} from "./inject";
export type { EnvironmentInjector, InjectFlags, InjectorLike } from "./inject";
export { forwardRef, isForwardRef, resolveForwardRef } from "./forward_ref";
export type { ForwardRefFn } from "./forward_ref";
export { matchRoute } from "./route_match";
export type { RouteMatchResult } from "./route_match";
export {
  createBearerAuthInterceptor,
  createHeaderInterceptor,
  createRetryInterceptor,
  createTimeoutInterceptor,
  withInterceptors,
} from "./interceptor";
export type { HttpInterceptorFn, HttpRequestPayload } from "./interceptor";
export {
  computed,
  effect,
  linkedSignal,
  signal,
  untracked,
} from "./signal";
export type { LinkedSignalOptions, Signal, WritableSignal } from "./signal";
export { resource } from "./resource";
export type {
  ResourceLoaderParams,
  ResourceOptions,
  ResourceRef,
  ResourceStatus,
} from "./resource";
export {
  RedirectCommand,
  executeRoutePipeline,
  isRedirectCommand,
} from "./route_pipeline";
export type {
  NavigationExtras,
  RoutePipelineContext,
  RoutePipelineDefinition,
  RoutePipelineOptions,
  RoutePipelineResult,
  RouterEvent,
  RouterEventType,
} from "./route_pipeline";
export { TestBed } from "./testing";
export type { TestModuleMetadata } from "./testing";
export {
  APP_BASE_HREF,
  ROUTER_CONFIGURATION,
  ROUTE_CONFIG,
  provideRouter,
  withComponentInputBinding,
  withRouterConfig,
  withTitleStrategy,
} from "./route_provider";
export type { RouterConfigOptions, RouterFeature } from "./route_provider";
export {
  DefaultTitleStrategy,
  TITLE_STRATEGY,
  TitleStrategy,
} from "./title_strategy";
export {
  joinWithSlash,
  normalizePath,
  stripTrailingSlash,
} from "./location";
export {
  TransferState,
  TRANSFER_STATE,
  makeStateKey,
} from "./transfer_state";
export type { StateKey } from "./transfer_state";
export {
  DOCUMENT,
  PLATFORM_BROWSER_ID,
  PLATFORM_EDGE_ID,
  PLATFORM_ID,
  PLATFORM_SERVER_ID,
  detectPlatform,
  isPlatformBrowser,
  isPlatformEdge,
  isPlatformServer,
} from "./platform";
export type { PlatformId } from "./platform";
export { HttpParams } from "./http_params";
export type { HttpParamsOptions } from "./http_params";
export { HttpHeaders } from "./http_headers";
export { HttpContext, HttpContextToken } from "./http_context";
export {
  HTTP_CLIENT_CONFIG,
  HTTP_INTERCEPTORS,
  HttpClient,
  HttpErrorResponse,
  provideHttpClient,
  withFetch,
  withRequestsMadeViaParent,
} from "./http_client";
export type {
  HttpClientConfig,
  HttpClientFeature,
  HttpClientFeatureKind,
  HttpRequestOptions,
} from "./http_client";
export {
  DefaultUrlSerializer,
  UrlSegmentGroup,
  UrlSerializer,
  UrlTree,
} from "./url_tree";
export type { UrlSegment } from "./url_tree";
export {
  AbstractControl,
  FormArray,
  FormControl,
  FormGroup,
  Validators,
} from "./forms";
export type {
  AbstractControlOptions,
  AsyncValidatorFn,
  FormControlStatus,
  ValidationErrors,
  ValidatorFn,
} from "./forms";
export {
  booleanAttribute,
  numberAttribute,
} from "./input_transform";
export {
  DatePipe,
  JsonPipe,
  LowerCasePipe,
  Pipe,
  TrimPipe,
  UpperCasePipe,
  getPipeMetadata,
} from "./pipe";
export type {
  PipeMetadata,
  PipeTransform,
} from "./pipe";
