/**
 * Default business-module authoring surface. UI, reactive state, HTTP clients
 * and runtime bootstrapping remain explicit integrations, not core exports.
 * Existing Angular-backed metadata/DI semantics are intentionally preserved.
 */
export {
  Body, Command, Controller, Cookie, Delete, Get, Head, Headers, Inject,
  Injectable, InfraResource, Job, Module, Optional, Options, Param, Patch,
  Post, Put, Query, UseGuards,
} from "./decorators";
export type {
  CanActivateFn, CommandOptions, ControllerOptions, InfraResourceOptions,
  EffectErrorMapping, EffectRetryPolicy, EffectRouteOptions, JobOptions, ModuleOptions, RouteOptions,
} from "./decorators";
export { InjectionToken } from "./token";
export type { InjectionTokenOptions } from "./token";
export {
  provideToken, provideConfig, makeEnvironmentProviders,
} from "./provider";
export type { Provider, ProviderDep, Token, Type } from "./provider";
export { defineModule, defineFeatureSlice, defineFeatureSpec } from "./module";
export type { FeatureSliceOptions, FeatureSpecOptions, FeatureState, FeatureEvent } from "./module";
export { defineRouteHandler, defineRouteContract, defineTypedRoute } from "./route_contract";
export type {
  RouteContractSchemas, RouteHandlerInput, RouteHandlerOutput, RouteResponseMap,
} from "./route_contract";
export type { Scope } from "./scope";
export type { Aspect, AspectContext, AspectNext } from "./aspect";
